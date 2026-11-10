import type NetFirewall from '@ohos.net.netFirewall'

// Only the system backend is replaced in the isolated local test snapshot.
enum RuleDirection { RULE_IN = 1, RULE_OUT = 2 }
enum RuleAction { RULE_ALLOW = 0, RULE_DENY = 1 }
enum RuleType { RULE_IP = 1, RULE_DOMAIN = 2, RULE_DNS = 3 }
enum OrderField { ORDER_BY_RULE_NAME = 1 }
enum OrderType { ORDER_ASC = 1 }

interface ScopedRule extends NetFirewall.NetFirewallRule { id: number }

class FirewallProbeBackend {
  readonly NetFirewallRuleDirection = RuleDirection
  readonly FirewallRuleAction = RuleAction
  readonly NetFirewallRuleType = RuleType
  readonly NetFirewallOrderField = OrderField
  readonly NetFirewallOrderType = OrderType
  policy: NetFirewall.NetFirewallPolicy = { isOpen: true, inAction: 0, outAction: 0 }
  rules: ScopedRule[] = []
  failAdd: boolean = false
  failuresInjected: number = 0
  nextId: number = 400

  async getNetFirewallPolicy(_userId: number): Promise<NetFirewall.NetFirewallPolicy> {
    return this.policy
  }

  async setNetFirewallPolicy(_userId: number, policy: NetFirewall.NetFirewallPolicy): Promise<void> {
    this.policy = policy
  }

  async getNetFirewallRules(_userId: number, _request: NetFirewall.RequestParam): Promise<NetFirewall.FirewallRulePage> {
    return { page: 1, pageSize: 50, totalPage: 1, data: this.rules.slice() }
  }

  async removeNetFirewallRule(_userId: number, ruleId: number): Promise<void> {
    this.rules = this.rules.filter((rule: ScopedRule): boolean => rule.id !== ruleId)
  }

  async addNetFirewallRule(rule: NetFirewall.NetFirewallRule): Promise<number> {
    if (this.failAdd && rule.name === 'failing target rule') {
      this.failuresInjected++
      throw new Error('synthetic rule application failure')
    }
    const id = this.nextId++
    this.rules.push({ id: id, userId: rule.userId, name: rule.name, isEnabled: rule.isEnabled,
      direction: rule.direction, type: rule.type, action: rule.action })
    return id
  }
}

export const firewallBackend = new FirewallProbeBackend()
export default firewallBackend
