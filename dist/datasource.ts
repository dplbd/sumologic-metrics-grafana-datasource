///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />

import _ from 'lodash';
import moment from 'moment';
import * as dateMath from 'app/core/utils/datemath';

const durationSplitRegexp = /(\d+)(ms|s|m|h|d|w|M|y)/;

// Things we still need to do:
// - Fully understand the code; it looks like there are still leftovers
//   from the Prometheus data source plugin in this code.
// - Decide on the final "DSL" for template variable queries in
//   metricFindQuery() and see if the autocomplete endpoint can do this
//   more efficiently.
// - start/end really shouldn't be instance fields on the data source
//   object but it is not clear how else to have a time range handy
//   for performSuggestQuery.
// - quantizationDefined is wonky and shouldn't be an instance field
//   either.
// - How to support alerting?
// - How to support annotations?

/** @ngInject */
export default class SumoLogicMetricsDatasource {

  url: string;
  basicAuth: boolean;
  start: number;
  end: number;
  error: string;
  quantizationDefined: boolean;
  latestQuery: string;

  /** @ngInject */
  constructor(instanceSettings, private backendSrv, private templateSrv, private $q) {
    this.url = instanceSettings.url;
    this.basicAuth = instanceSettings.basicAuth;
    console.log("sumo-logic-metrics-datasource - Datasource created.");
  }

  // Main API.

  // Called by Grafana to, well, test a datasource. Invoked
  // during Save & Test on a Datasource editor screen.
  testDatasource() {
    return this.metricFindQuery('metrics|*').then(() => {
      return {status: 'success', message: 'Data source is working', title: 'Success'};
    });
  }

  // Called by Grafana to find values for template variables.
  metricFindQuery(query) {

    // Bail out immediately if the caller didn't specify a query.
    if (!query) {
      return this.$q.when([]);
    }

    // With the help of templateSrv, we are going to first of all figure
    // out the current values of all template variables.
    let templateVariables = {};
    _.forEach(_.clone(this.templateSrv.variables), variable => {
      let name = variable.name;
      let value = variable.current.value;

      // Prepare the an object for this template variable in the map
      // following the same structure as options.scopedVars from
      // this.query() so we can then in the next step simply pass
      // on the map to templateSrv.replace().
      templateVariables[name] = {'selelected': true, 'text': value, 'value': value};
    });

    // Resolve template variables in the query to their current value.
    let interpolated;
    try {
      interpolated = this.templateSrv.replace(query, templateVariables);
    } catch (err) {
      return this.$q.reject(err);
    }

    if (interpolated.startsWith("values|")) {
      return this.getValuesFromAutocomplete(interpolated);
    }

    // Unknown query type - error.
    return this.$q.reject("Unknown metric find query: " + query);
  }

  getValuesFromAutocomplete(interpolatedQuery) {
    let split = interpolatedQuery.split("|");

    // The metatag whose values we want to enumerate.
    let key = split[1];

    // The query to constrain the result - a metrics selector.
    let metricsSelector = split[2];

    // PLEASE NOTE THAT THIS IS USING AN UNOFFICIAL APU AND IN
    // GENERAL EXPERIMENTAL - BUT IT IS BETTER THAN NOTHING AND
    // IT DOES IN FACT WORK. WE WILL UPDATE TEMPLATE VARIABLE
    // QUERY FUNCTIONALITY ONCE AN OFFICIAL PUBLIC API IS OUT.
    //
    // Returns the values for the key specified as the parameter
    // given the metrics selector given in query. This is a much
    // more efficient way to get the value for a key than the
    // method used in getAvailableMetaTags() which might return
    // a lot of duplicated data.
    //
    // Given key '_sourceCategory' and metrics selector
    // '_contentType=HostMetrics metric=CPU_LoadAvg_1Min' this
    // will ask the autocomplete endpoint for all values for
    // key '_sourceCategory' by constructing the following
    // autocomplete query:
    //
    //  _contentType=HostMetrics metric=CPU_LoadAvg_1Min _sourceCategory=
    //
    // We also need to tell the autocomplete endpopint the
    // position of the "cursor", so it notes from where in the
    // query it should find completitions from. The result will
    // look something like this:
    //
    // {
    //   "queryId": 0,
    //   "query": "_contentType=HostMetrics metric=CPU_LoadAvg_1Min _sourceCategory=",
    //   "pos": 65,
    //   "queryStartTime": 0,
    //   "queryEndTime": 0,
    //   "suggestions": [
    //   {
    //     "sectionName": "Values",
    //     "highlighted": null,
    //     "items": [
    //       {
    //         "display": "alert",
    //         ...
    //       },
    //       {
    //         "display": "analytics",
    //         ...
    //         }
    //       },
    //       {
    //         "display": "attack",
    //         ...
    //       },
    //       ...
    //     ]
    // ],
    // ...
    // }

    // Create the final query with the key appended.
    let finalQuery = metricsSelector + " " + key + "=";
    let position = finalQuery.length;

    let startTime = this.start || 0;
    let endTime = this.end || 0;
    let url = '/api/v1/metrics/suggest/autocomplete';
    let data = {
      queryId: 1,
      query: finalQuery,
      pos: position,
      apiVersion: "0.2.0",
      queryStartTime: startTime,
      queryEndTime: endTime,
      requestedSectionsAndCounts: {
        values: 1000
      }
    };
    return this._sumoLogicRequest('POST', url, data)
      .then(result => {
        if (result.data.suggestions.length < 1) {
          return [];
        }
        return _.map(result.data.suggestions[0].items, suggestion => {
          return {
            text: suggestion.display,
          };
        });
      });
  }

  // Called by Grafana to execute a metrics query.
  query(options) {

    let self = this;

    // Get the start and end time for the query. Remember the values so
    // we can reuse them during performSuggestQuery, where we will also
    // need a time range.
    this.start = options.range.from.valueOf();
    this.end = options.range.to.valueOf();

    // This gives us the upper limit of data points to be returned
    // by the Sumo backend and seems to be based on the width in
    // pixels of the panel.
    let maxDataPoints = options.maxDataPoints;

    // Empirically, it seems that we get better looking graphs
    // when requesting some fraction of the indicated width...
    let requestedDataPoints = Math.round(maxDataPoints / 6);

    // Figure out the desired quantization.
    let desiredQuantization = this.calculateInterval(options.interval);

    const targets = options.targets;
    const queries = [];
    _.each(options.targets, target => {
      if (!target.expr || target.hide) {
        return;
      }

      // Reset previous errors, if any.
      target.error = null;

      let query: any = {};
      query.expr = this.templateSrv.replace(target.expr, options.scopedVars);
      query.requestId = options.panelId + target.refId;
      queries.push(query);
    });

    // If there's no valid targets, return the empty result to
    // save a round trip.
    if (_.isEmpty(queries)) {
      let d = this.$q.defer();
      d.resolve({data: []});
      return d.promise;
    }

    // Set up the promises.
    let queriesPromise = [
      this.doMetricsQuery(
        queries,
        this.start,
        this.end,
        maxDataPoints,
        requestedDataPoints,
        desiredQuantization)];

    // Execute the queries and collect all the results.
    return this.$q.all(queriesPromise).then(responses => {
      let result = [];
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        if (response.status === 'error') {
          throw response.error;
        }
        result = self.transformMetricData(targets, response.data.response);
      }

      // Return the results.
      return {data: result};
    });
  }

  // Helper methods.

  // Called from SumoLogicMetricsQueryCtrl.
  performSuggestQuery(query) {
    let url = '/api/v1/metrics/suggest/autocomplete';
    let data = {
      query,
      pos: query.length,
      queryStartTime: this.start,
      queryEndTime: this.end
    };
    this.latestQuery = query;
    return this._sumoLogicRequest('POST', url, data).then(result => {
        if (this.latestQuery !== query) {
            return {suggestions: [], query, falseReturn: true};
        }
      let suggestionsList = [];
      _.each(result.data.suggestions, suggestion => {
        _.each(suggestion.items, item => {
          suggestionsList.push(item.replacement.text);
        });
      });
      return {suggestions: suggestionsList, query, falseReturn: false};
    });
  }

  // Transform results from the Sumo Logic Metrics API called in
  // query() into the format Grafana expects.
  transformMetricData(targets, responses) {

    let seriesList = [];
    let errors = [];

    for (let i = 0; i < responses.length; i++) {
      let response = responses[i];
      let target = targets[i];

      if (!response.messageType) {
        for (let j = 0; j < response.results.length; j++) {
          let result = response.results[j];

          // Synthesize the "target" - the "metric name" basically.
          let target = "";
          let dimensions = result.metric.dimensions;
          let firstAdded = false;
          for (let k = 0; k < dimensions.length; k++) {
            let dimension = dimensions[k];
            if (dimension.legend === true) {
              if (firstAdded) {
                target += ",";
              }
              target += dimension.key + "=" + dimension.value;
              firstAdded = true;
            }
          }

          // Create Grafana-suitable datapoints.
          let values = result.datapoints.value;
          let timestamps = result.datapoints.timestamp;
          let length = Math.min(values.length, timestamps.length);
          let datapoints = [];
          for (let l = 0; l < length; l++) {
            let value = values[l];
            let valueParsed = parseFloat(value);
            let timestamp = timestamps[l];
            let timestampParsed = parseFloat(timestamp);
            datapoints.push([valueParsed, timestampParsed]);
          }

          // Add the series.
          seriesList.push({target: target, datapoints: datapoints});
        }
      } else {
        console.log("sumo-logic-metrics-datasource - Datasource.transformMetricData - error: " +
          JSON.stringify(response));
        errors.push(response.message);
      }
    }

    if (errors.length > 0) {
      throw {message: errors.join("<br>")};
    }

    return seriesList;
  }

  doMetricsQuery(queries, start, end, maxDataPoints,
                 requestedDataPoints, desiredQuantization) {
    if (start > end) {
      throw {message: 'Invalid time range'};
    }
    let queryList = [];
    for (let i = 0; i < queries.length; i++) {
      queryList.push({
        'query': queries[i].expr,
        'rowId': queries[i].requestId,
      });
    }
    let url = '/api/v1/metrics/annotated/results';
    let data = {
      'query': queryList,
      'startTime': start,
      'endTime': end,
      'maxDataPoints': maxDataPoints,
      'requestedDataPoints': requestedDataPoints
    };
    if (this.quantizationDefined && desiredQuantization) {
      data['desiredQuantizationInSecs'] = desiredQuantization;
    }
    console.log("sumo-logic-metrics-datasource - Datasource.doMetricsQuery: " +
      JSON.stringify(data));
    return this._sumoLogicRequest('POST', url, data);
  }

  _sumoLogicRequest(method, url, data) {
    let options: any = {
      url: this.url + url,
      method: method,
      data: data,
      withCredentials: this.basicAuth,
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.basicAuth,
      }
    };
    return this.backendSrv.datasourceRequest(options).then(result => {
      return result;
    }, function (err) {
      if (err.status !== 0 || err.status >= 300) {
        if (err.data && err.data.error) {
          throw {
            message: 'Sumo Logic Error: ' + err.data.error,
            data: err.data,
            config: err.config
          };
        } else {
          throw {
            message: 'Network Error: ' + err.statusText + '(' + err.status + ')',
            data: err.data,
            config: err.config
          };
        }
      }
    });
  }

  calculateInterval(interval) {
    let m = interval.match(durationSplitRegexp);
    let dur = moment.duration(parseInt(m[1]), m[2]);
    let sec = dur.asSeconds();
    if (sec < 1) {
      sec = 1;
    }
    return Math.ceil(sec);
  };

  changeQuantization() {
    this.quantizationDefined = true;
  };

  callCatalogBrowser(query) {
      this.latestQuery = query;
      const parsed = this.parseQuery(query);
      let url = '/api/v1/metrics/meta/catalog/query';
      let data = {
          query: parsed.newQuery,
          offset: 0,
          limit: 10,
      };
      let keysUrl = '/api/v1/metrics/suggest/autocomplete';
      let keysData = {
          query,
          pos: query.length,
          queryStartTime: this.start,
          queryEndTime: this.end
      };

      return this.$q.all([
          this._sumoLogicRequest('POST', url, data),
          this._sumoLogicRequest('POST', keysUrl, keysData)
      ]).then(results => {
          let result = results[0];
          let keys = "";

          if (results[1].data.suggestions[0] && results[1].data.suggestions[0].sectionName !== null
              && results[1].data.suggestions[0].sectionName.toLowerCase()==="keys") {
              _.each(results[1].data.suggestions[0].items, item => {
                  keys+=item.display+", ";
              });
          }

          keys = keys.length===0 ?  "none": keys.slice(0, keys.length-2);

          if (result.data.results.length === 0 || this.latestQuery !== query) {
              return {
                  colNames: [],
                  colRows: [],
                  specifiedCols: 0,
                  matchedCols: 0,
                  falseReturn: this.latestQuery !== query,
                  keys,
              };
          }

          let queryMatch = '';
          const queryPart = query.split(' ');
          if (queryPart[queryPart.length-1].length !==0 && queryPart[queryPart.length-1].indexOf('=') < 0) {
              queryMatch = queryPart[queryPart.length-1];
          }
          let cols = parsed.filters;
          let colVals: any = {};
          let colOrder: any = {};
          let rowNum = 0;
          const numRows = result.data.results.length;

          // initialize specified columns
          cols.forEach((col) => {
              colVals[col] = new Array(numRows);
              colOrder[col] = 0;
          });

          _.each(result.data.results, metric => {

              metric.metaTags.forEach((item) => {
                  const key = String(item.key).toLowerCase();
                  if (key==="_rawname") {
                      return;
                  }
                  const queryInside = queryMatch.length>0 && new RegExp(parsed.openQuery.join("|")).test(item.value.toLowerCase());
                  if (_.has(colVals, key)) {
                      if (colOrder[key]===2 &&  queryInside) {
                          colOrder[key] = 1;
                      }
                  } else {
                          colVals[key] = new Array(numRows);
                          colOrder[key] = queryInside? 1 : 2;
                  }
                  //colVals[key][rowNum] = queryInside? "<span class='matched'>"+queryMatch+"</span>"+
                      //item.value.slice(queryMatch.length) : item.value;
                  colVals[key][rowNum] = item.value;
              });

              metric.dimensions.forEach((item) => {
                  const key = String(item.key).toLowerCase();
                  if (key==="_rawname") {
                      return;
                  }
                  const queryInside = queryMatch.length>0 && new RegExp(parsed.openQuery.join("|")).test(item.value.toLowerCase());
                  if (_.has(colVals, key)) {
                    if (colOrder[key]===2 && queryInside){
                      colOrder[key] = 1;
                    }
                  } else {
                      colVals[key] = new Array(numRows);
                      colOrder[key] = queryInside? 1 : 2;
                  }

                  //colVals[key][rowNum] = queryInside? "<span class='matched'>"+queryMatch+"</span>"+
                      //item.value.slice(queryMatch.length) : item.value;
                  colVals[key][rowNum] = item.value;
              });

              rowNum += 1;
          });

          const zero = [];
          const one = [];
          const two = [];

          Object.getOwnPropertyNames(colOrder).forEach((colName) => {
             if (colOrder[colName]===0){
               zero.push(colName);
             } else if (colOrder[colName]===1){
               one.push(colName);
             } else {
               two.push(colName);
             }
          });

          const colNames = zero.concat(one).concat(two);
          const colRows = [];
          colNames.forEach((col) => {
            colRows.push(colVals[col]);
          });

          return {keys, colNames, colRows, specifiedCols: zero.length, matchedCols: zero.length+one.length, falseReturn: false};

      });

  }

  parseQuery(query) {
    const queryParts = query.toLowerCase().split(' ');
    let newQuery = '';
    const openQuery = [];
    const filters = [];
    queryParts.forEach((part) => {
      const params = part.split('=');
      if (params.length>1) {
        filters.push(params[0]);
        newQuery+= ' ' + part;
      } else {
          newQuery += ' *' + part +'*';
          openQuery.push(part);
      }
    });
    return {filters, newQuery, openQuery};
  }

}
