/**
 * Created by austin on 5/20/15.
 */

'use strict';

import _ from 'lodash';
import minimatch from 'minimatch';
import include from 'underscore.string/include';

import APIError from './APIError';
import buildActionParams from './buildActionParams';
import dbs from '../db';
import config from '../config';
import hasParam from './hasParam';
import scoreNameMatch from './scoreNameMatch';

const defaultFields = Object.keys(dbs._v2Schema);

module.exports.actions = {
  'find': 'find'
  , 'findOne': 'findOne'
};

function applyParams(collection, query) {
  var params = buildActionParams('v2', _.omit(query, 'name'));
  if (params.length < 1) return collection.data;
  return collection.find(params);
}

function getNameCriteria(query) {
  if (!query.name) return null;
  let result = {};
  result.val = query.name;

  if (~query.name.indexOf(',')) {
    result.regex = minimatch.makeRe(`{${query.name}}`);
  } else if (~query.name.indexOf('*')) {
    result.regex = minimatch.makeRe(query.name);
  }

  return result;
}

module.exports.processRequest = function (collection, query, action, exactMatch, cb) {
  switch (action) {
    case this.actions.find:
      _find(collection, query, exactMatch, cb);
      break;
    case this.actions.findOne:
      _findOne(collection, query, exactMatch, cb);
      break;
    default:
      var error = new APIError(`Invalid action ${action} request of api.v2`, 501);
      return cb(error);
  }
};

// process request for generic query against a cdn collection
function _find(collection, query, exactMatch, cb) {

  // Filter it down to the meat of the query
  var nameCriteria = getNameCriteria(query),
    libs = applyParams(collection, query);

  // Filter down the list of matches and sort by levenstein distance
  if (nameCriteria !== null) {
    libs = _(libs)
    .transform(function(result, lib) {
      var score = scoreNameMatch(lib, nameCriteria);
      if (score >= 0) {
        result.push({
          score: score,
          lib: lib
        });
      }
    }, [])
    .sortBy('score')
    .pluck('lib')
    .value();
  }

  return cb(null, _formatResponse(query, libs));
}

function _findOneLoose(libs, nameCriteria) {
  var model, score = Infinity;
  // Custom handling of ?name param
  for (var i = 0; i < libs.length; i++) {
    var _score = scoreNameMatch(libs[i], nameCriteria);
    if (_score === -1) continue;
    if (_score < score) {
      model = libs[i];
      score = _score;
    }
    // Break on exact match
    if (score === 0) break;
  }
  return model;
}

function _findOneExact(libs, nameCriteria) {
  return _.find(libs, {
    name: nameCriteria.val
  });
}

// process request for singular library or singular libraries version files
function _findOne(collection, query, exactMatch, cb) {
  if (!hasParam('v2', query)) {
    var error = new APIError('A query must be specified. Refer to our documentation at https://github.com/jsdelivr/api', 404);
    return cb(error);
  }

  var nameCriteria = getNameCriteria(query),
    libs = applyParams(collection, query);

  var model;
  if (nameCriteria !== null) {
    model = exactMatch ?
              _findOneExact(libs, nameCriteria) :
              _findOneLoose(libs, nameCriteria);
  }
  // See #86
  else if (nameCriteria === null && !exactMatch) {
    model = _.first(libs);
  }

  // move etag resource header into place
  if (exactMatch) {
    var etagsCollection = dbs[config.etagsCollection]
      , cdnCache = etagsCollection.findOne({'cdn': collection.name}) || {etags: []}
      , etagObj = _.find(cdnCache.etags, {path: model.name});
    model._headers = etagObj ? {ETag: etagObj.etag} : {};
  }

  if (model === void 0) {
    // Resolve with an empty array
    var error = new APIError('Requested project not found.', 404);
    return cb(error);
  }

  // the api v1 specs only attempt to get project files for a version
  // when permorming a '.../libraries/<NAME>/<VERSION>' query
  if (query.version) {
    var files = _selectVersionFiles(query.version, model);
    if (files) {
      return cb(null, files);
    }
    var error = new APIError('Requested version not found.', 404);
    return cb(error);
  }

  //return cb(null, _selectFields(query.fields, model));
  return cb(null, _formatResponse(query, model));
}

function _selectVersionFiles(version, model) {
  var versionAssets = _.find(model.assets, {version: version});
  return _.result(versionAssets, 'files');
}

// pick out only the specified fields to return
function _selectFields(fields, models) {
  fields = typeof fields === 'string' && fields ? fields.split(',') : defaultFields;

  if (_.isArray(models)) {
    return _.map(models, _.partial(_.pick, _, fields));
  }
  else {
    return _.pick(models, fields);
  }
}

// structure the response according to v2 schema and pass through to _selectFields
function _formatResponse(query, models) {

  function _formatModel(model, excludeAssets) {
    model.assets = excludeAssets ? void 0 : _.map(model.assets, asset => {
      var obj = {};
      obj[asset.version] = asset;
      delete asset.version;
      return obj;
    });
    model.$loki = void 0;
  }

  var response = _.cloneDeep(models);
  var excludeAssets = !query.fields || !~query.fields.indexOf('assets');

  if (_.isArray(response)) {
    response = _.map(response, function (model) {
      if (model.assets) {
        _formatModel(model, excludeAssets);
      }
      return model;
    });
  }
  else {
    _formatModel(response, false);
  }

  return _selectFields(query.fields, response);
}