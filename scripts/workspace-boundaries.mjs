import { builtinModules } from "node:module";

import babelParser from "@babel/parser";

const { parse } = babelParser;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const networkGlobals = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);

export function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "");
  return [...builtins].some(
    (builtin) => normalized === builtin || normalized.startsWith(`${builtin}/`),
  );
}

function parseSource(content) {
  return parse(content, {
    plugins: ["typescript", "jsx", "importAttributes", "decorators-legacy"],
    sourceType: "unambiguous",
  });
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visitor);
    return;
  }
  if (typeof node.type === "string") visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (["comments", "errors", "extra", "loc", "tokens"].includes(key)) continue;
    walk(child, visitor);
  }
}

function stringValue(node) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

export function importedSpecifiers(content) {
  const specifiers = new Set();
  walk(parseSource(content), (node) => {
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      const value = stringValue(node.source);
      if (value) specifiers.add(value);
    } else if (node.type === "TSImportEqualsDeclaration") {
      const value = stringValue(node.moduleReference?.expression);
      if (value) specifiers.add(value);
    } else if (node.type === "ImportExpression") {
      const value = stringValue(node.source);
      if (value) specifiers.add(value);
    } else if (node.type === "CallExpression") {
      const isDynamicImport = node.callee?.type === "Import";
      const isRequire = node.callee?.type === "Identifier" && node.callee.name === "require";
      if (isDynamicImport || isRequire) {
        const value = stringValue(node.arguments?.[0]);
        if (value) specifiers.add(value);
      }
    }
  });
  return [...specifiers];
}

function accessedProperty(node) {
  if (!["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return undefined;
  const property = node.computed ? stringValue(node.property) : node.property?.name;
  return { object: node.object, property };
}

export function forbiddenDomainGlobals(content) {
  const violations = new Set();
  walk(parseSource(content), (node) => {
    const access = accessedProperty(node);
    if (access?.object?.type === "Identifier") {
      if (access.object.name === "process" && access.property === "env") {
        violations.add("process.env");
      }
      if (access.object.name === "globalThis" && networkGlobals.has(access.property)) {
        violations.add(`globalThis.${access.property}`);
      }
    }

    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      if (networkGlobals.has(node.callee.name)) violations.add(node.callee.name);
    }
    if (node.type === "NewExpression" && node.callee?.type === "Identifier") {
      if (networkGlobals.has(node.callee.name)) violations.add(node.callee.name);
    }
  });
  return [...violations];
}
