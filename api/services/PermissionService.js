var _ = require('lodash');
var helpers = require('../../lib/helpers');

var methodMap = {
  POST: 'create',
  GET: 'read',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete'
};

var wlFilter = require('waterline-criteria');

module.exports = {

  /**
   * Given an object, or a list of objects, return true if the list contains
   * objects not owned by the specified user.
   */
  hasForeignObjects: function(objects, user) {
    if (!_.isArray(objects)) {
      return PermissionService.isForeignObject(user.id)(objects);
    }
    return _.any(objects, PermissionService.isForeignObject(user.id));
  },

  /**
   * Return whether the specified object is NOT owned by the specified user.
   */
  isForeignObject: function(owner) {
    return function(object) {
      //sails.log.verbose('object', object);
      //sails.log.verbose('object.owner: ', object.owner, ', owner:', owner);
      return object.owner !== owner;
    };
  },

  /**
   * Find objects that some arbitrary action would be performed on, given the
   * same request.
   *
   * @param options.model
   * @param options.query
   *
   * TODO this will be less expensive when waterline supports a caching layer
   */
  findTargetObjects: function(req) {

    var action = PermissionService.getMethod(req.method);

    // handle add/remove routes that use :parentid and :childid as the primary key fields
    var parentId;
    var childId;

    if (req.params.parentid) {
      parentId = req.params.parentid;
      req.params.id = req.params.parentid;
      delete req.params.parentid;
    }

    if (req.params.childid) {
      childId = req.params.childid;
      delete req.params.childid;
    }

    return new Promise(function(resolve, reject) {

        var findAction;

        switch (action) {
          case 'read':
            findAction = require('sails/lib/hooks/blueprints/actions/find')
            break;
          default:
            findAction = require('sails/lib/hooks/blueprints/actions/findOne')
            break;
        }

        findAction(req, {
          ok: resolve,
          badRequest: reject,
          serverError: reject,
          // this isn't perfect, since it returns a 500 error instead of a 404 error
          // but it is better than crashing the app when a record doesn't exist
          notFound: reject
        });
      })
      .then(function(result) {
        if (parentId !== undefined) {
          delete req.params.id;
          req.params.parentid = parentId;
        }
        if (childId !== undefined) {
          req.params.childid = childId;
        }
        return result;
      });
  },

  /**
   * Query Permissions that grant privileges to a role/user on an action for a
   * model.
   *
   * @param options.method
   * @param options.model
   * @param options.user
   */
  findModelPermissions: function(options) {
    //console.log('findModelPermissions options', options)
    //console.log('findModelPermissions action', action)

    let helperOptions = {
      model: options.model,
      action: PermissionService.getMethod(options.method),
      populate: ['criteria', 'objectFilters']
    };

    return helpers.findUserPermissions(options.user, helperOptions);
  },

  /**
   * Generate final permissions criteria from permissions object.
   *
   * @param perm
   * @returns {Array}
   */
  genPermissionCriteria: function(perm) {

    var permCriteria = [];
    var objFilterCriteria = [];

    // have criteria?
    if (
      true === _.has(perm, 'criteria') &&
      true === _.isArray(perm.criteria) &&
      false === _.isEmpty(perm.criteria)
    ) {
      // yes, loop all
      perm.criteria.forEach(function (criteria) {
        // set owner flag?
        if (perm.relation === 'owner') {
          // yes
          criteria.owner = true;
        }
        // push onto perm criteria
        permCriteria.push(criteria);
      });
    }

    // have object filters?
    if (
      true === _.has(perm, 'objectFilters') &&
      true === _.isArray(perm.objectFilters) &&
      false === _.isEmpty(perm.objectFilters)
    ) {
      // yes, build where criteria for every id
      perm.objectFilters.forEach((o) => {
        objFilterCriteria.push({where: {id: o.objectId}});
      });
    }

    // have both?
    if (permCriteria.length && objFilterCriteria.length) {

      // yes, its an and
      let finalCriteria = {
        where: {
          and: []
        }
      };

      // more than one criteria?
      if (permCriteria.length > 1) {
        // yes, use sub-or
        finalCriteria.where.and.push({
          or: permCriteria.map(o => o.where)
        });
      } else {
        // just one object filter
        finalCriteria.where.and.push(permCriteria[0].where);
      }

      // more than one object filter?
      if (objFilterCriteria.length > 1) {
        // yes, use sub-or
        finalCriteria.where.and.push({
          or: objFilterCriteria.map(o => o.where)
        });
      } else {
        // just one object filter
        finalCriteria.where.and.push(objFilterCriteria[0].where);
      }

      // all done
      return [finalCriteria];

    } else if (permCriteria.length) {
      // only return perm criteria
      return permCriteria;
    } else if (objFilterCriteria.length) {
      // only return object filters
      return objFilterCriteria;
    } else {
      // If a permission has no criteria then it passes for all cases
      // (like the admin role)
      return [{where: {}}];
    }
  },

  /**
   * Given a list of objects, determine if they all satisfy at least one permission's
   * where clause/attribute blacklist combination
   *
   * @param {Array of objects} objects - The result of the query, or if the action is create,
   * the body of the object to be created
   * @param {Array of Permission objects} permissions - An array of permission objects
   * that are relevant to this particular user query
   * @param {Object} attributes - The body of the request, in an update or create request.
   * The keys of this object are checked against the permissions blacklist
   * @returns boolean - True if there is at least one granted permission that allows the requested action,
   * otherwise false
   */
  hasPassingCriteria: function(objects, permissions, attributes, user) {
    // return success if there are no permissions or objects
    if (_.isEmpty(permissions) || _.isEmpty(objects)) return true;

    if (!_.isArray(objects)) {
      objects = [objects];
    }

    var criteria = permissions.reduce(function (memo, perm) {
      if (perm) {
        var permCriteria = PermissionService.genPermissionCriteria(perm);
        memo = memo.concat(permCriteria);
        return memo;
      }
    }, []);


    if (!_.isArray(criteria)) {
      criteria = [criteria];
    }

    if (_.isEmpty(criteria)) {
      return true;
    }

    // every object must have at least one permission that has a passing criteria and a passing attribute check
    return objects.every(function(obj) {
      return criteria.some(function(criteria) {
        var match = wlFilter([obj], {
          where: criteria.where
        }).results;
        var hasUnpermittedAttributes = PermissionService.hasUnpermittedAttributes(attributes, criteria.blacklist);
        var hasOwnership = true; // edge case for scenario where a user has some permissions that are owner based and some that are role based
        if (criteria.owner) {
          hasOwnership = !PermissionService.isForeignObject(user)(obj);
        }
        return match.length === 1 && !hasUnpermittedAttributes && hasOwnership;
      });
    });

  },

  hasUnpermittedAttributes: function(attributes, blacklist) {
    if (_.isEmpty(attributes) || _.isEmpty(blacklist)) {
      return false;
    }
    return _.intersection(Object.keys(attributes), blacklist).length ? true : false;
  },

  /**
   * Return true if the specified model supports the ownership policy; false
   * otherwise.
   */
  hasOwnershipPolicy: function(model) {
    return (
      true === 'autoCreatedBy' in model &&
      true === model.autoCreatedBy
    );
  },

  /**
   * Build an error message
   */
  getErrorMessage: function(options) {
    var user = options.user.email || options.user.username
    return [
      'User', user, 'is not permitted to', options.method, options.model.name
    ].join(' ');
  },

  /**
   * Given an action, return the CRUD method it maps to.
   */
  getMethod: function(method) {
    return methodMap[method];
  },

  /**
   * create a new role
   * @param options
   * @param options.name {string} - role name
   * @param options.permissions {permission object, or array of permissions objects}
   * @param options.permissions.model {string} - the name of the model that the permission is associated with
   * @param options.permissions.criteria - optional criteria object
   * @param options.permissions.criteria.where - optional waterline query syntax object for specifying permissions
   * @param options.permissions.criteria.blacklist {string array} - optional attribute blacklist
   * @param options.users {array of user names} - optional array of user ids that have this role
   */
  createRole: function(options) {

    var ok = Promise.resolve();
    var permissions = options.permissions;

    if (!_.isArray(permissions)) {
      permissions = [permissions];
    }


    // look up the model id based on the model name for each permission, and change it to an id
    ok = ok.then(function() {
      return Promise.all(permissions.map(function(permission) {
        return Model.findOne({
            name: permission.model
          })
          .then(function(model) {
            permission.model = model.id;
            return permission;
          });
      }));
    });

    // look up user ids based on usernames, and replace the names with ids
    ok = ok.then(function(permissions) {
      if (options.users) {
        return User.find({
            username: options.users
          })
          .then(function(users) {
            options.users = users;
          });
      }
    });

    ok = ok.then(function(users) {
      return Role.create(options).meta({fetch: true});
    });

    return ok;
  },

  /**
   *
   * @param options {permission object, or array of permissions objects}
   * @param options.role {string} - the role name that the permission is associated with,
   *                                either this or user should be supplied, but not both
   * @param options.user {string} - the user than that the permission is associated with,
   *                                either this or role should be supplied, but not both
   * @param options.model {string} - the model name that the permission is associated with
   * @param options.action {string} - the http action that the permission allows
   * @param options.criteria - optional criteria object
   * @param options.criteria.where - optional waterline query syntax object for specifying permissions
   * @param options.criteria.blacklist {string array} - optional attribute blacklist
   */
  grant: function(permissions) {
    if (!_.isArray(permissions)) {
      permissions = [permissions];
    }

    // look up the models based on name, and replace them with ids
    var ok = Promise.all(permissions.map(function(permission) {
      var findRole = permission.role ? Role.findOne({
        name: permission.role
      }) : null;
      var findUser = permission.user ? User.findOne({
        username: permission.user
      }) : null;
      return Promise.all([findRole, findUser, Model.findOne({
          name: permission.model
        })])
        .then(([ role, user, model]) => {
          permission.model = model.id;
          if (role && role.id) {
            permission.role = role.id;
          } else if (user && user.id) {
            permission.user = user.id;
          } else {
            return Promise.reject(new Error('no role or user specified'));
          }
        });
    }));

    ok = ok.then(function() {
      return Permission.create(permissions).meta({fetch: true});
    });

    return ok;
  },

  /**
   * add one or more users to a particular role
   * TODO should this work with multiple roles?
   * @param usernames {string or string array} - list of names of users
   * @param rolename {string} - the name of the role that the users should be added to
   */
  addUsersToRole: function(usernames, rolename) {
    if (_.isEmpty(usernames)) {
      return Promise.reject(new Error('One or more usernames must be provided'));
    }

    if (!_.isArray(usernames)) {
      usernames = [usernames];
    }

    return Role.findOne({
      name: rolename
    }).populate('users').then(function(role) {
      return User.find({
        username: usernames
      }).then(function(users) {
        role.users.add(_.pluck(users, 'id'));
        return role.save();
      });
    });
  },

  /**
   * remove one or more users from a particular role
   * TODO should this work with multiple roles
   * @params usernames {string or string array} - name or list of names of users
   * @params rolename {string} - the name of the role that the users should be removed from
   */
  removeUsersFromRole: function(usernames, rolename) {
    if (_.isEmpty(usernames)) {
      return Promise.reject(new Error('One or more usernames must be provided'));
    }

    if (!_.isArray(usernames)) {
      usernames = [usernames];
    }

    return Role.findOne({
        name: rolename
      })
      .populate('users')
      .then(function(role) {
        return User.find({
          username: usernames
        }, {
          select: ['id']
        }).then(function(users) {
          users.map(function(user) {
            role.users.remove(user.id);
          });
          return role.save();
        });
      });
  },

  /**
   * revoke permission from role
   * @param options
   * @param options.role {string} - the name of the role related to the permission.  This, or options.user should be set, but not both.
   * @param options.user {string} - the name of the user related to the permission.  This, or options.role should be set, but not both.
   * @param options.model {string} - the name of the model for the permission
   * @param options.action {string} - the name of the action for the permission
   * @param options.relation {string} - the type of the relation (owner or role)
   */
  revoke: function(options) {
    var findRole = options.role ? Role.findOne({
      name: options.role
    }) : null;
    var findUser = options.user ? User.findOne({
      username: options.user
    }) : null;
    var ok = Promise.all([findRole, findUser, Model.findOne({
      name: options.model
    })]);

    ok = ok.then(([ role, user, model ]) => {

      var query = {
        model: model.id,
        action: options.action,
        relation: options.relation
      };

      if (role && role.id) {
        query.role = role.id;
      } else if (user && user.id) {
        query.user = user.id;
      } else {
        return Promise.reject(new Error('You must provide either a user or role to revoke the permission from'));
      }

      return Permission.destroy(query);
    });

    return ok;
  },

  /**
   * Check if the user (out of role) is granted to perform action on given objects
   * @param objects
   * @param user
   * @param action
   * @param model
   * @param body
   * @returns {*}
   */
  isAllowedToPerformAction: function(objects, user, action, model, body) {
    if (!_.isArray(objects)) {
      return PermissionService.isAllowedToPerformSingle(user.id, action, model, body)(objects);
    }
    return Promise.all(objects.map(PermissionService.isAllowedToPerformSingle(user.id, action, model, body)))
      .then(function (allowedArray) {
        return allowedArray.every(function (allowed) {
          return allowed === true;
        });
      });
  },

  /**
   * Resolve if the user have the permission to perform this action
   * @param user
   * @param action
   * @param model
   * @param body
   * @returns {Function}
   */
  isAllowedToPerformSingle: function(user, action, model, body) {
    return function(obj) {
      return new Promise(function(resolve, reject) {
        Model.findOne({
          identity: model
        }).then(function(model) {
         return Permission.find({
            model: model.id,
            action: action,
            relation: 'user',
            user: user
          }).populate('criteria').populate('objectFilters');
        }).then(function(permission) {
          if (permission.length > 0 && PermissionService.hasPassingCriteria(obj, permission, body)) {
            resolve(true);
          } else {
            resolve(false);
          }
        }).catch(reject);
      });
    };
  }
};
