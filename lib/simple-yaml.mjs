function parseScalar(rawValue, source, lineNumber) {
  const value = rawValue.trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);

  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new Error(`${source}:${lineNumber} 字符串格式错误：${error.message}`);
      }
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((item) => parseScalar(item, source, lineNumber));
  }

  return value;
}


function splitMapping(text, source, lineNumber) {
  const separator = text.indexOf(":");
  if (separator <= 0) {
    throw new Error(`${source}:${lineNumber} 应使用“键: 值”格式。`);
  }
  const key = text.slice(0, separator).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`${source}:${lineNumber} 配置键“${key}”格式无效。`);
  }
  return { key, value: text.slice(separator + 1).trim() };
}


function setUnique(target, key, value, source, lineNumber) {
  if (Object.hasOwn(target, key)) {
    throw new Error(`${source}:${lineNumber} 配置键“${key}”重复。`);
  }
  target[key] = value;
}


export function parseSimpleYaml(contents, { source = "<yaml>" } = {}) {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  const tokens = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/\t/.test(raw)) {
      throw new Error(`${source}:${index + 1} 不支持 Tab 缩进，请使用两个空格。`);
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`${source}:${index + 1} 缩进必须是两个空格的倍数。`);
    }
    tokens.push({ indent, text: trimmed, lineNumber: index + 1 });
  }

  if (tokens.length === 0) return {};
  if (tokens[0].indent !== 0) {
    throw new Error(`${source}:${tokens[0].lineNumber} 顶层配置不能缩进。`);
  }

  function parseBlock(startIndex, indent) {
    const isSequence = tokens[startIndex]?.indent === indent
      && tokens[startIndex].text.startsWith("- ");
    const container = isSequence ? [] : {};
    let index = startIndex;

    while (index < tokens.length) {
      const token = tokens[index];
      if (token.indent < indent) break;
      if (token.indent > indent) {
        throw new Error(`${source}:${token.lineNumber} 存在无法归属的缩进。`);
      }

      if (isSequence) {
        if (!token.text.startsWith("- ")) break;
        const itemText = token.text.slice(2).trim();
        if (!itemText) {
          if (tokens[index + 1]?.indent !== indent + 2) {
            throw new Error(`${source}:${token.lineNumber} 列表项不能为空。`);
          }
          const child = parseBlock(index + 1, indent + 2);
          container.push(child.value);
          index = child.nextIndex;
          continue;
        }

        if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(itemText)) {
          const item = {};
          const mapping = splitMapping(itemText, source, token.lineNumber);
          if (mapping.value) {
            setUnique(item, mapping.key, parseScalar(mapping.value, source, token.lineNumber), source, token.lineNumber);
            index += 1;
          } else {
            if (tokens[index + 1]?.indent !== indent + 2) {
              throw new Error(`${source}:${token.lineNumber} “${mapping.key}”缺少值。`);
            }
            const child = parseBlock(index + 1, indent + 2);
            setUnique(item, mapping.key, child.value, source, token.lineNumber);
            index = child.nextIndex;
          }

          while (index < tokens.length && tokens[index].indent === indent + 2
            && !tokens[index].text.startsWith("- ")) {
            const propertyToken = tokens[index];
            const property = splitMapping(propertyToken.text, source, propertyToken.lineNumber);
            if (property.value) {
              setUnique(item, property.key, parseScalar(property.value, source, propertyToken.lineNumber), source, propertyToken.lineNumber);
              index += 1;
            } else {
              if (tokens[index + 1]?.indent !== indent + 4) {
                throw new Error(`${source}:${propertyToken.lineNumber} “${property.key}”缺少值。`);
              }
              const child = parseBlock(index + 1, indent + 4);
              setUnique(item, property.key, child.value, source, propertyToken.lineNumber);
              index = child.nextIndex;
            }
          }
          container.push(item);
          continue;
        }

        container.push(parseScalar(itemText, source, token.lineNumber));
        index += 1;
        continue;
      }

      if (token.text.startsWith("- ")) break;
      const mapping = splitMapping(token.text, source, token.lineNumber);
      if (mapping.value) {
        setUnique(container, mapping.key, parseScalar(mapping.value, source, token.lineNumber), source, token.lineNumber);
        index += 1;
      } else {
        if (tokens[index + 1]?.indent !== indent + 2) {
          throw new Error(`${source}:${token.lineNumber} “${mapping.key}”缺少值。`);
        }
        const child = parseBlock(index + 1, indent + 2);
        setUnique(container, mapping.key, child.value, source, token.lineNumber);
        index = child.nextIndex;
      }
    }

    return { value: container, nextIndex: index };
  }

  const parsed = parseBlock(0, 0);
  if (parsed.nextIndex !== tokens.length) {
    const token = tokens[parsed.nextIndex];
    throw new Error(`${source}:${token.lineNumber} YAML 结构无效。`);
  }
  return parsed.value;
}
