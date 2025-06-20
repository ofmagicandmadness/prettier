import assert from "node:assert";
import { getSortedChildNodes } from "./comments/attach.js";

const isJsonParser = ({ parser }) =>
  parser === "json" ||
  parser === "json5" ||
  parser === "jsonc" ||
  parser === "json-stringify";

function findCommonAncestor(startNodeAndParents, endNodeAndParents) {
  const startNodeAndAncestors = [
    startNodeAndParents.node,
    ...startNodeAndParents.parentNodes,
  ];
  const endNodeAndAncestors = new Set([
    endNodeAndParents.node,
    ...endNodeAndParents.parentNodes,
  ]);
  return startNodeAndAncestors.find(
    (node) =>
      jsonSourceElements.has(node.type) && endNodeAndAncestors.has(node),
  );
}

function dropRootParents(parents) {
  const index = parents.findLastIndex(
    (node) => node.type !== "Program" && node.type !== "File",
  );

  if (index === -1) {
    return parents;
  }

  return parents.slice(0, index + 1);
}

function findSiblingAncestors(
  startNodeAndParents,
  endNodeAndParents,
  { locStart, locEnd },
) {
  let resultStartNode = startNodeAndParents.node;
  let resultEndNode = endNodeAndParents.node;

  if (resultStartNode === resultEndNode) {
    return {
      startNode: resultStartNode,
      endNode: resultEndNode,
    };
  }

  const startNodeStart = locStart(startNodeAndParents.node);
  for (const endParent of dropRootParents(endNodeAndParents.parentNodes)) {
    if (locStart(endParent) >= startNodeStart) {
      resultEndNode = endParent;
    } else {
      break;
    }
  }

  const endNodeEnd = locEnd(endNodeAndParents.node);
  for (const startParent of dropRootParents(startNodeAndParents.parentNodes)) {
    if (locEnd(startParent) <= endNodeEnd) {
      resultStartNode = startParent;
    } else {
      break;
    }
    if (resultStartNode === resultEndNode) {
      break;
    }
  }

  return {
    startNode: resultStartNode,
    endNode: resultEndNode,
  };
}

function findNodeAtOffset(
  node,
  offset,
  options,
  predicate,
  parentNodes = [],
  type,
) {
  const { locStart, locEnd } = options;
  const start = locStart(node);
  const end = locEnd(node);

  if (
    offset > end ||
    offset < start ||
    (type === "rangeEnd" && offset === start) ||
    (type === "rangeStart" && offset === end)
  ) {
    return;
  }

  for (const childNode of getSortedChildNodes(node, options)) {
    const childResult = findNodeAtOffset(
      childNode,
      offset,
      options,
      predicate,
      [node, ...parentNodes],
      type,
    );
    if (childResult) {
      return childResult;
    }
  }

  if (!predicate || predicate(node, parentNodes[0])) {
    return {
      node,
      parentNodes,
    };
  }
}

// See https://www.ecma-international.org/ecma-262/5.1/#sec-A.5
function isJsSourceElement(type, parentType) {
  return (
    parentType !== "DeclareExportDeclaration" &&
    type !== "TypeParameterDeclaration" &&
    (type === "Directive" ||
      type === "TypeAlias" ||
      type === "TSExportAssignment" ||
      type.startsWith("Declare") ||
      type.startsWith("TSDeclare") ||
      type.endsWith("Statement") ||
      type.endsWith("Declaration"))
  );
}

const jsonSourceElements = new Set([
  "JsonRoot",
  "ObjectExpression",
  "ArrayExpression",
  "StringLiteral",
  "NumericLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "UnaryExpression",
  "TemplateLiteral",
]);
const graphqlSourceElements = new Set([
  "OperationDefinition",
  "FragmentDefinition",
  "VariableDefinition",
  "TypeExtensionDefinition",
  "ObjectTypeDefinition",
  "FieldDefinition",
  "DirectiveDefinition",
  "EnumTypeDefinition",
  "EnumValueDefinition",
  "InputValueDefinition",
  "InputObjectTypeDefinition",
  "SchemaDefinition",
  "OperationTypeDefinition",
  "InterfaceTypeDefinition",
  "UnionTypeDefinition",
  "ScalarTypeDefinition",
]);
function isSourceElement(opts, node, parentNode) {
  /* c8 ignore next 3 */
  if (!node) {
    return false;
  }
  switch (opts.parser) {
    case "flow":
    case "babel":
    case "babel-flow":
    case "babel-ts":
    case "typescript":
    case "acorn":
    case "espree":
    case "meriyah":
    case "oxc":
    case "oxc-ts":
    case "__babel_estree":
      return isJsSourceElement(node.type, parentNode?.type);
    case "json":
    case "json5":
    case "jsonc":
    case "json-stringify":
      return jsonSourceElements.has(node.type);
    case "graphql":
      return graphqlSourceElements.has(node.kind);
    case "vue":
      return node.tag !== "root";
  }
  return false;
}

function calculateRange(text, opts, ast) {
  let { rangeStart: start, rangeEnd: end, locStart, locEnd } = opts;
  assert.ok(end > start);
  // Contract the range so that it has non-whitespace characters at its endpoints.
  // This ensures we can format a range that doesn't end on a node.
  const firstNonWhitespaceCharacterIndex = text.slice(start, end).search(/\S/u);
  const isAllWhitespace = firstNonWhitespaceCharacterIndex === -1;
  if (!isAllWhitespace) {
    start += firstNonWhitespaceCharacterIndex;
    for (; end > start; --end) {
      if (/\S/u.test(text[end - 1])) {
        break;
      }
    }
  }

  const startNodeAndParents = findNodeAtOffset(
    ast,
    start,
    opts,
    (node, parentNode) => isSourceElement(opts, node, parentNode),
    [],
    "rangeStart",
  );
  const endNodeAndParents =
    // No need find Node at `end`, it will be the same as `startNodeAndParents`
    isAllWhitespace
      ? startNodeAndParents
      : findNodeAtOffset(
          ast,
          end,
          opts,
          (node) => isSourceElement(opts, node),
          [],
          "rangeEnd",
        );
  if (!startNodeAndParents || !endNodeAndParents) {
    return {
      rangeStart: 0,
      rangeEnd: 0,
    };
  }

  let startNode;
  let endNode;
  if (isJsonParser(opts)) {
    const commonAncestor = findCommonAncestor(
      startNodeAndParents,
      endNodeAndParents,
    );
    startNode = commonAncestor;
    endNode = commonAncestor;
  } else {
    ({ startNode, endNode } = findSiblingAncestors(
      startNodeAndParents,
      endNodeAndParents,
      opts,
    ));
  }

  return {
    rangeStart: Math.min(locStart(startNode), locStart(endNode)),
    rangeEnd: Math.max(locEnd(startNode), locEnd(endNode)),
  };
}

export { calculateRange };
