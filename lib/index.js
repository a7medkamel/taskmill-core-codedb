var express     = require('express')
  , Promise     = require('bluebird')
  , bodyParser  = require('body-parser')
  , winston     = require('winston')
  , config      = require('config-url')
  , _           = require('lodash')
  , urljoin     = require('url-join')
  , url         = require('url')
  , morgan      = require('morgan')
  , WError      = require('verror').WError
  , VError      = require('verror').VError
  , Repository  = require('./git/repository')
  , Make        = require('./make')
  , jwt         = require('./middleware/jwt')
  , xhub        = require('./middleware/git_host').xhub
  , git_host    = require('./rest/git_host')
  , Blob        = require('./model/blob')
  ;

var app = express();

app.use(xhub);
app.use(bodyParser.json());

app.use(morgan('short'));

app.post('/sha', jwt.token, (req, res, next) => {
  let remote          = req.body.remote
    , branch          = req.body.branch
    , token           = req.body.token
    ;

  Repository
    .get(remote, { pull : true, acl : true, token })
    .then((repo) => {
      return repo.sha_ify(branch, { cache : true })
    })
    .then((sha) => {
      res.send({
        sha : sha
      });
    })
    .catch((err) => {
      winston.error(remote, err);
      res.status(400).send({ message : err.message });
    });
});

app.post('/blob', jwt.token, (req, res, next) => {
  var remote          = req.body.remote   //|| 'https://github.com/a7medkamel/taskmill-core-agent.git'
    , branch          = req.body.branch   || 'master' // todo [akamel] not used, should let sha-ify do it's thing
    , filename        = req.body.filename //|| 'lib/core/worker.js'
    , token           = req.body.token
    , populate        = req.body.populate || {}
    ;

  // winston.debug('/blob', remote, branch, filename, token, populate);
  Repository
    .get(remote, { pull : true, acl : true, token })
    .then((repo) => {
      // todo [akamel] this can leak repo existance, mask with 'file not found'
      return repo
              .stat(filename, branch)
              .then((stat) => {
                // let limit = 1024 /* 1kb */ * 10
                let limit = config.get('codedb.file_size_limit');
                if (stat.rawsize > limit) {
                  throw new WError({ name : 'BLOB_SIZE_ERROR', info : { remote, branch, filename, stat } }, `file is larger than ${limit} limit`);
                }

                if (stat.isBinary) {
                  throw new WError({ name : 'BLOB_TYPE_ERROR', info : { remote, branch, filename, stat } }, `file is binary`);
                }

                return Promise
                        .all([
                            repo.cat(filename, branch)
                          , repo.updatedAt()
                          , repo.read_rec()
                        ])
                        .spread((text, at, rec) => {
                          let blob = new Blob(remote, filename, { branch, text })
                            , meta = blob.metadata(populate)
                            , item = {
                                stat        : stat
                              , repository  : rec
                              // todo [akamel] this doesn't have branch/commit
                              , uid         : urljoin(remote + '+', filename)
                              // todo [akamel] add branch and path to ls as well...
                              , branch      : branch
                              , path        : filename[0] === '/'? filename : '/' + filename
                              , updatedAt   : at
                              , content     : text
                            };

                          _.extend(item, meta);

                          return item;
                        });
              });
    })
    .then((response) => {
      res.send(response);
    })
    .catch((err) => {
      if (err instanceof WError) {
        winston.info(err.message, VError.info(err));
      } else {
        winston.error(remote, err);
      }

      res.status(400).send({ message : err.message, name : err.name });
    });
});

app.post('/pull', jwt.token, (req, res, next) => {
  var remote          = req.body.remote
    , token           = req.body.token
    , populate        = req.body.populate
    ;

  Repository
    .get(remote, { pull : 'force', acl : true, token })
    .then(() => {
      res.send({ message : 'OK' });
    })
    .catch((err) => {
      winston.error(remote, err);
      res.status(400).send({ message : err.message });
    });
});

app.post('/build', jwt.token, (req, res, next) => {
  var remote          = req.body.remote
    , token           = req.body.token
    , branch          = req.body.branch
    , tailf           = req.body.tailf
    ;

  Repository
    .get(remote, { pull : true, acl : true, token })
    .then((repo) => {
      return repo
              .sha_ify(branch)
              .then((sha) => {
                return { repo, sha };
              })
    })
    .then(({ repo, sha }) => {
      let key = repo.key();

      return Make
              .read_build(repo, sha)
              .then((image) => {
                winston.info(image, repo.remote(), sha);
                if (image) {
                  res.set('image', image);
                  res.status(304).send();
                  return;
                }

                return Make
                        .build(repo, sha, { tailf })
                        .then((output = {}) => {
                          res.status(200).send(output);
                        });
              });
    })
    .catch((err) => {
      let { name, message, log } = err;

      winston.error(remote, { name, message, log : log? log.toString() : undefined });

      let response = { name, message };

      if (log) {
        response.log = log.toString();
      }

      res.status(400).send(response);
    });
});

app.post('/ls', jwt.token, (req, res, next) => {
  var remote          = req.body.remote
    , token           = req.body.token
    , branch          = req.body.branch
    , populate        = req.body.populate
    ;

  Repository
    .get(remote, { pull : true, acl : true, token })
    .then((repo) => {
      return Promise
                .all([
                    repo.ls(branch)
                  , repo.updatedAt()
                  , repo.read_rec()
                ])
                .spread((result, at, rec) => {
                  return {
                      updatedAt   : at
                    , data        : result.data
                    , repository  : rec
                  }
                })
                .tap((result) => {
                  if (_.isEmpty(populate)) {
                    return result;
                  }

                  let limited = _.take(result.data, config.get('codedb.populate.limit'));
                  return Promise
                          .map(limited, (item) => {
                            if (populate.repository) {
                              item.repository = repo.full_name();
                            }

                            if (populate.username) {
                              item.username = repo.username();
                            }

                            return repo
                                    .stat(item.path)
                                    .then((stat) => {
                                      if (stat.rawsize > 1024 /* 1kb */ * 10) {
                                        item.rawsize = stat.rawsize;
                                        return item;
                                      }

                                      if (stat.isBinary) {
                                        item.binary = true;
                                        return item;
                                      }

                                      return repo
                                              .cat(item.path)
                                              .then((text) => {
                                                if (populate.blob) {
                                                  item.blob = text;
                                                }

                                                let meta = Blob.metadata_js(text, populate);

                                                _.extend(item, meta);

                                                return item;
                                              })
                                              .catch((err) => {
                                                // supress errors in populate
                                                return item;
                                              });
                                    });
                          });
                });
    })
    .then((result) => {
      res.send(result);
    })
    .catch((err) => {
      winston.error(remote, err);
      res.status(400).send({ message : err.message });
    });
});

app.post('/githook', git_host.hook);

function listen(options, cb) {
  return Promise
          .fromCallback((cb) => {
            app.listen(options.port, cb);
          })
          .then(() => {
            if (config.get('codedb.pull-on-start')) {
              Repository.pullAll();
            }
          })
          .nodeify(cb);
}

module.exports = {
    listen : listen
};
