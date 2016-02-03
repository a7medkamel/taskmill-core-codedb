var config    = require('config')
  , http      = require('./lib')
  ;

process.on('uncaughtException', function (err) {
  console.error(err.stack || err.toString());
});

function main() {
  http.listen({ port : config.get('http.port') });
}

if (require.main === module) {
  main();
}

module.exports = {
    main  : main
};