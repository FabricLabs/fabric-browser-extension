/*******************************
          JSON Editor
*******************************/

/*
  Edits each JSON file in the stream: an object editor is merged in
  (objects merge, arrays concatenate, anything else is replaced), a
  function editor returns the new value. Output keeps the file's indentation.
*/

var
  Transform   = require('stream').Transform,

  // keys that would let a merged file reach Object.prototype
  unsafeKeys  = ['__proto__', 'constructor', 'prototype']
;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    return target.concat(source);
  }
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return source;
  }
  var result = {};
  [target, source].forEach(function(object) {
    Object.keys(object).forEach(function(key) {
      if (unsafeKeys.indexOf(key) !== -1) {
        return;
      }
      result[key] = (object === source && Object.prototype.hasOwnProperty.call(result, key))
        ? merge(result[key], object[key])
        : object[key]
      ;
    });
  });
  return result;
}

module.exports = function(editor, options) {
  options = options || {};
  if (typeof editor !== 'function' && !isPlainObject(editor)) {
    throw new Error('json-editor: editor must be a function or an object');
  }
  return new Transform({
    objectMode: true,
    transform: function(file, encoding, callback) {
      if (file.isNull()) {
        return callback(null, file);
      }
      if (file.isStream()) {
        return callback(new Error('json-editor: streaming is not supported'));
      }
      try {
        var
          text   = file.contents.toString('utf8'),
          indent = (text.match(/^([ \t]+)\S/m) || [])[1] || '  ',
          json   = JSON.parse(text),
          edited = (typeof editor === 'function')
            ? editor(json)
            : merge(json, editor),
          output = JSON.stringify(edited, null, indent)
        ;
        if (options.end_with_newline) {
          output += '\n';
        }
        file.contents = Buffer.from(output);
        callback(null, file);
      } catch (error) {
        callback(error);
      }
    }
  });
};
