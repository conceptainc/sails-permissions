var gulp = require("gulp");
var watch = require("gulp-watch");
var babel = require("gulp-babel");

gulp.task("default", function () {
  gulp.src("api/**")
    .pipe(babel())
    .pipe(gulp.dest("dist/api"));

  gulp.src("config/**")
    .pipe(babel())
    .pipe(gulp.dest("dist/config"));

  gulp.src("lib/**")
    .pipe(babel())
    .pipe(gulp.dest("dist/lib"));
});

gulp.task('watch', function () {
   gulp.watch(['api/**', 'config/**', 'lib/**'], ['default']);
});
