/*******************************
       Conditional Pipe Step
*******************************/

/*
  Pipes through `step` when `condition` is truthy, otherwise passes files on.
  Conditions are plain values (booleans, settings objects), never globs.
*/

var
  PassThrough = require('stream').PassThrough
;

module.exports = function(condition, step) {
  return condition
    ? step
    : new PassThrough({ objectMode: true })
  ;
};
