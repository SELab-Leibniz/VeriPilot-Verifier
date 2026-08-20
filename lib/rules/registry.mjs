export class RuleTypeRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (this.definitions.has(definition.type)) {
      throw new Error(`规则类型“${definition.type}”重复注册。`);
    }
    this.definitions.set(definition.type, definition);
    return this;
  }

  get(type) {
    return this.definitions.get(type) ?? null;
  }

  list() {
    return [...this.definitions.values()];
  }

  async compile(rule, context) {
    const definition = this.get(rule.type);
    if (!definition?.compile) return false;
    await definition.compile(rule, context);
    return true;
  }

  evaluate(rule, context) {
    return this.get(rule.type)?.evaluate?.(rule, context) ?? [];
  }

  proposeFixes(rule, context) {
    return this.get(rule.type)?.proposeFixes?.(rule, context) ?? [];
  }
}


export function composeRuleTypeRegistries(...registries) {
  const definitions = [];
  const registeredTypes = new Set();
  for (const registry of registries) {
    if (!registry) continue;
    for (const definition of registry.list()) {
      if (registeredTypes.has(definition.type)) continue;
      registeredTypes.add(definition.type);
      definitions.push(definition);
    }
  }
  return new RuleTypeRegistry(definitions);
}
