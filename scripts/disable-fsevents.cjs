"use strict";

const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithoutFsevents(request, parent, isMain) {
  if (request === "fsevents") {
    const error = new Error("fsevents is disabled for this polling watcher");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
