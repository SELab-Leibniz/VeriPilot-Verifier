function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "object" ? "object" : typeof value;
}


const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "default", "examples",
  "type", "required", "properties", "items", "const", "enum", "pattern",
  "minLength", "minItems", "uniqueItems", "additionalProperties", "minimum",
]);


function inspectSchema(schema, pointer, unsupported) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) unsupported.push(pointerChild(pointer, key));
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    inspectSchema(child, pointerChild(pointerChild(pointer, "properties"), key), unsupported);
  }
  if (schema.items && typeof schema.items === "object") {
    inspectSchema(schema.items, pointerChild(pointer, "items"), unsupported);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    inspectSchema(schema.additionalProperties, pointerChild(pointer, "additionalProperties"), unsupported);
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    inspectSchema(child, pointerChild(pointerChild(pointer, "$defs"), key), unsupported);
  }
}


export function assertSupportedJsonSchema(schema, source = "JSON Schema") {
  const unsupported = [];
  inspectSchema(schema, "", unsupported);
  if (unsupported.length > 0) {
    throw new Error(`${source} 使用了当前零依赖校验器不支持的关键字：${unsupported.join("、")}。`);
  }
}


function pointerChild(pointer, key) {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}


function matchesType(value, expected) {
  const actual = valueType(value);
  if (Array.isArray(expected)) return expected.some((item) => matchesType(value, item));
  if (expected === "number") return actual === "integer" || actual === "number";
  return actual === expected;
}


function add(errors, pointer, keyword, message, expected, actual) {
  errors.push({
    pointer: pointer || "/",
    keyword,
    message,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
  });
}


function resolveReference(reference, rootSchema) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  let current = rootSchema;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current?.[segment];
  }
  if (!current || typeof current !== "object") {
    throw new Error(`JSON Schema reference does not exist: ${reference}`);
  }
  return current;
}


function validateNode(value, schema, pointer, errors, rootSchema) {
  if (!schema || typeof schema !== "object") return;

  if (schema.$ref !== undefined) {
    validateNode(value, resolveReference(schema.$ref, rootSchema), pointer, errors, rootSchema);
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    add(errors, pointer, "type", `应为 ${JSON.stringify(schema.type)}，实际为 ${valueType(value)}。`, schema.type, valueType(value));
    return;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    add(errors, pointer, "const", `必须等于 ${JSON.stringify(schema.const)}。`, schema.const, value);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    add(errors, pointer, "enum", `必须是 ${schema.enum.map((item) => JSON.stringify(item)).join("、")} 之一。`, schema.enum, value);
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      add(errors, pointer, "minLength", `长度至少为 ${schema.minLength}。`, schema.minLength, value.length);
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) {
      add(errors, pointer, "pattern", `必须匹配正则 ${schema.pattern}。`, schema.pattern, value);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      add(errors, pointer, "minimum", `必须大于或等于 ${schema.minimum}。`, schema.minimum, value);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      add(errors, pointer, "minItems", `至少需要 ${schema.minItems} 项。`, schema.minItems, value.length);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) add(errors, pointer, "uniqueItems", "数组包含重复项。");
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => validateNode(item, schema.items, pointerChild(pointer, index), errors, rootSchema));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        add(errors, pointerChild(pointer, required), "required", `缺少必填字段 ${required}。`, "present", "missing");
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateNode(child, properties[key], pointerChild(pointer, key), errors, rootSchema);
      else if (schema.additionalProperties === false) {
        add(errors, pointerChild(pointer, key), "additionalProperties", `不允许字段 ${key}。`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(child, schema.additionalProperties, pointerChild(pointer, key), errors, rootSchema);
      }
    }
  }
}


export function validateJsonSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "", errors, schema);
  return errors;
}
