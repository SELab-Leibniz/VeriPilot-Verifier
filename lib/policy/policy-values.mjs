export function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} 必须是非空字符串列表。`);
  }
  return value;
}


export function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  return stringArray(value, label);
}
