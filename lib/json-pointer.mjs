function decodeToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}


export function valueAtJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map(decodeToken)
    .reduce((value, key) => value?.[key], document);
}
