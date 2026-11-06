/*******************************
        Ordered Sources
*******************************/

/*
  Reads each glob to its end before opening the next, so files come out in
  the order of `globs`. gulp 5 returns a single brace glob in directory order,
  and the packaged CSS and JS depend on component order.
*/

var
  gulp        = require('gulp'),
  PassThrough = require('stream').PassThrough
;

module.exports = function(globs) {
  var output = new PassThrough({ objectMode: true });

  function next(index) {
    if (index === globs.length) {
      output.end();
      return;
    }
    gulp.src(globs[index])
      .on('data', function(file) {
        output.write(file);
      })
      .on('error', function(error) {
        output.destroy(error);
      })
      .on('end', function() {
        next(index + 1);
      })
    ;
  }

  next(0);
  return output;
};
