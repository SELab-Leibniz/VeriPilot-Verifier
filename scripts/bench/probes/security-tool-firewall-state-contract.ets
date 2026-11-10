// Sources: the public task's rollback, confirmed-reload and mutual-exclusion
// requirements, and the task-start ViewModel's pending-state messages.
// SDK and preference substitutes keep policy writes in memory.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@ohos/hypium'
import { common } from '@kit.AbilityKit'
import { netFirewall } from '@kit.NetworkKit'
import { ArgumentMatchers, MockKit, when } from '@ohos/hamock'
import { FirewallService } from '../main/ets/services/firewall/FirewallService'
import { FirewallModeSwitchService } from '../main/ets/services/firewall/FirewallModeSwitchService'
import { FirewallModeStrategy } from '../main/ets/services/firewall/FirewallModeStrategy'
import { SystemUserProvider } from '../main/ets/services/firewall/providers/SystemUserProvider'
import { PreferencesAccessor } from '../main/ets/storage/preferences/PreferencesAccessor'
import {
  FirewallOperationResult, FirewallOverviewState, FirewallPreparedRule, FirewallPresetMode,
  FirewallRuleIntentMappingData, FirewallToggleOperationResult,
  PREF_KEY_FIREWALL_ACTIVE_MODE, PREF_KEY_FIREWALL_RULE_MAPPING, UserFirewallListResult
} from '../main/ets/services/firewall/FirewallModels'
import { FirewallOverviewViewModel } from '../main/ets/viewmodels/firewall/overview/FirewallOverviewViewModel'
import { firewallBackend } from '../mock/__rc_contract_probe_sdk'

class Scenario {
  rejectSwitch: boolean = false
  returnFailure: boolean = false
  switches: number = 0
  toggles: number = 0
  loads: number = 0
}
class ModeResponse implements FirewallOperationResult { success: boolean = true }
class ToggleSuccess implements FirewallToggleOperationResult {
  success: boolean = true
  targetEnabled: boolean = true
}
class ConfirmedOverview implements FirewallOverviewState {
  enabled: boolean = true
  currentMode: FirewallPresetMode = 'custom'
}
const context = {} as common.UIAbilityContext
const userId = 42
const originalId = 300
const originalName = 'existing rule'

interface ScopedRule extends netFirewall.NetFirewallRule { id: number }

function probeRule(name: string, id: number): ScopedRule {
  return {
    id: id, userId: userId, name: name, isEnabled: true,
    direction: netFirewall.NetFirewallRuleDirection.RULE_IN,
    type: netFirewall.NetFirewallRuleType.RULE_IP,
    action: netFirewall.FirewallRuleAction.RULE_DENY
  }
}

class RollbackState {
  mode: string = 'custom'
  mapping: string = ''
  failModeWrite: boolean = false
  failuresInjected: number = 0

  originalPolicy(): netFirewall.NetFirewallPolicy {
    return { isOpen: true, inAction: netFirewall.FirewallRuleAction.RULE_ALLOW,
      outAction: netFirewall.FirewallRuleAction.RULE_ALLOW }
  }

  reset(): void {
    this.mode = 'custom'
    firewallBackend.policy = this.originalPolicy()
    firewallBackend.rules = [probeRule(originalName, originalId)]
    firewallBackend.failAdd = false
    firewallBackend.failuresInjected = 0
    this.failModeWrite = false
    firewallBackend.nextId = 400
    this.failuresInjected = 0
    const data: FirewallRuleIntentMappingData = {
      version: 1,
      ruleIntents: [{
        localRuleId: 'existing', name: originalName, type: netFirewall.NetFirewallRuleType.RULE_IP,
        direction: netFirewall.NetFirewallRuleDirection.RULE_IN, action: netFirewall.FirewallRuleAction.RULE_DENY,
        isEnabled: true, targetUserIds: [userId], createdAt: 1, updatedAt: 1
      }],
      ruleDeployments: [{ localRuleId: 'existing', userId: userId, systemRuleId: originalId }]
    }
    this.mapping = JSON.stringify(data)
  }

  async getString(key: string, fallback: string): Promise<string> {
    return key === PREF_KEY_FIREWALL_ACTIVE_MODE ? this.mode : fallback
  }

  async getJsonObject<T>(key: string, fallback: T): Promise<T> {
    if (key !== PREF_KEY_FIREWALL_RULE_MAPPING) return fallback
    return JSON.parse(this.mapping) as T
  }

  async setValue(key: string, value: string): Promise<boolean> {
    if (key !== PREF_KEY_FIREWALL_ACTIVE_MODE) return false
    this.mode = value
    // Model a persistence operation that writes before reporting failure.
    if (this.failModeWrite && value === 'public') {
      this.failuresInjected++
      return false
    }
    return true
  }

  async setJson(key: string, value: object): Promise<boolean> {
    if (key !== PREF_KEY_FIREWALL_RULE_MAPPING) return false
    this.mapping = JSON.stringify(value)
    return true
  }
}

function publicFirewallRollbackContract(): void {
  describe('RCPublicFirewallRollbackContract', () => {
    const state = new RollbackState()
    const mocks = new MockKit()
    beforeAll(() => {
      const users = mocks.mockFunc(SystemUserProvider, SystemUserProvider.loadAvailableUserIds)
      const userList: UserFirewallListResult = { users: [{ userId: userId, label: 'probe user' }] }
      when(users)().afterReturn(Promise.resolve(userList))
      const prefs = mocks.mockFunc(PreferencesAccessor, PreferencesAccessor.of)
      when(prefs)(ArgumentMatchers.any).afterReturn(state as never as PreferencesAccessor)
      const build = mocks.mockFunc(FirewallModeStrategy, FirewallModeStrategy.buildRulesForMode)
      const target: FirewallPreparedRule[] = [
        { userId: userId, rule: probeRule('applied target rule', -1) },
        { userId: userId, rule: probeRule('failing target rule', -1) }
      ]
      when(build)(ArgumentMatchers.any).afterReturn(Promise.resolve(target))
    })
    beforeEach(() => { state.reset() })
    afterAll(() => { mocks.clearAll() })

    const assertRestoredRules = (): void => {
      expect(firewallBackend.rules.length).assertEqual(1)
      expect(firewallBackend.rules[0].name).assertEqual(originalName)
      const mapping = JSON.parse(state.mapping) as FirewallRuleIntentMappingData
      expect(mapping.ruleIntents.length).assertEqual(1)
      expect(mapping.ruleDeployments.length).assertEqual(1)
      expect(mapping.ruleDeployments[0].localRuleId).assertEqual('existing')
      expect(mapping.ruleDeployments[0].systemRuleId).assertEqual(firewallBackend.rules[0].id)
    }

    it('control applies the target mode and rules through the same simulated backend', 0, async () => {
      const result = await FirewallModeSwitchService.switchMode(context, 'public')
      expect(result.success).assertTrue()
      expect(state.mode).assertEqual('public')
      expect(firewallBackend.rules.length).assertEqual(2)
      expect(firewallBackend.rules[0].name).assertEqual('applied target rule')
    })

    it('failed partial switch restores the policy and binds the saved mapping to the live rule', 0, async () => {
      firewallBackend.failAdd = true
      const result = await FirewallModeSwitchService.switchMode(context, 'public')
      expect(firewallBackend.failuresInjected).assertEqual(1)
      expect(result.success).assertFalse()
      expect(state.mode).assertEqual('custom')
      expect(firewallBackend.policy.inAction).assertEqual(state.originalPolicy().inAction)
      assertRestoredRules()
    })

    it('a failed mode write restores the persisted mode and the previous rule mapping', 0, async () => {
      state.failModeWrite = true
      const result = await FirewallModeSwitchService.switchMode(context, 'public')
      expect(state.failuresInjected).assertEqual(1)
      expect(result.success).assertFalse()
      expect(state.mode).assertEqual('custom')
      assertRestoredRules()
    })
  })
}

export default function publicFirewallStateContract(): void {
  describe('RCPublicFirewallStateContract', () => {
    const scenario = new Scenario()
    const mocks = new MockKit()
    beforeAll(() => {
      // Replace each method once in this separate native process. The mutable
      // scenario selects outcomes without stacking MockKit wrappers.
      const switchMode = mocks.mockFunc(FirewallService, FirewallService.switchMode)
      when(switchMode)(ArgumentMatchers.any).afterAction((): FirewallOperationResult => {
        scenario.switches++
        if (scenario.rejectSwitch) { throw new Error('public task dependency failure') }
        const response = new ModeResponse()
        response.success = !scenario.returnFailure
        return response
      })
      const toggle = mocks.mockFunc(FirewallService, FirewallService.setFirewallEnabledForAllUsers)
      when(toggle)(ArgumentMatchers.any).afterAction((): FirewallToggleOperationResult => {
        scenario.toggles++
        return new ToggleSuccess()
      })
      const load = mocks.mockFunc(FirewallService, FirewallService.loadOverviewState)
      when(load)(ArgumentMatchers.any).afterAction((): FirewallOverviewState => {
        scenario.loads++
        return new ConfirmedOverview()
      })
    })
    beforeEach(() => {
      scenario.rejectSwitch = false
      scenario.returnFailure = false
      scenario.switches = 0
      scenario.toggles = 0
      scenario.loads = 0
    })
    afterAll(() => { mocks.clearAll() })

    it('control preserves the original pending-toggle response', 0, async () => {
      const model = new FirewallOverviewViewModel()
      model.state.isToggleProcessing = true
      const result = await model.requestToggle(context, true)
      expect(result.success).assertFalse()
      expect(result.errorMessage).assertEqual('toggle in progress')
      expect(scenario.toggles).assertEqual(0)
    })
    it('control preserves the original pending-mode response', 0, async () => {
      const model = new FirewallOverviewViewModel()
      model.state.isModeProcessing = true
      const result = await model.requestModeSwitch(context, 'public')
      expect(result.success).assertFalse()
      expect(result.errorMessage).assertEqual('mode switch in progress')
      expect(scenario.switches).assertEqual(0)
    })
    it('control preserves a normal mode call and confirmed reload through the service seam', 0, async () => {
      const model = new FirewallOverviewViewModel()
      const result = await model.requestModeSwitch(context, 'public')
      expect(result.success).assertTrue()
      expect(scenario.switches).assertEqual(1)
      expect(scenario.loads).assertEqual(1)
      expect(model.state.currentMode).assertEqual('custom')
      expect(model.state.enabled).assertTrue()
      // The existing result port also reports a returned failure via success.
      scenario.returnFailure = true
      const failed = await model.requestModeSwitch(context, 'public')
      expect(failed.success).assertFalse()
      expect(scenario.switches).assertEqual(2)
      expect(scenario.loads).assertEqual(2)
    })
    it('control preserves a normal toggle call and confirmed reload through the service seam', 0, async () => {
      const model = new FirewallOverviewViewModel()
      const result = await model.requestToggle(context, true)
      expect(result.success).assertTrue()
      expect(scenario.toggles).assertEqual(1)
      expect(scenario.loads).assertEqual(1)
      expect(model.state.enabled).assertTrue()
    })
    it('a rejected mode request identifies the already pending toggle', 0, async () => {
      const model = new FirewallOverviewViewModel()
      model.state.isToggleProcessing = true
      const result = await model.requestModeSwitch(context, 'public')
      expect(result.success).assertFalse()
      expect(result.errorMessage).assertEqual('toggle in progress')
      expect(scenario.switches).assertEqual(0)
    })
    it('a rejected toggle request identifies the already pending mode switch', 0, async () => {
      const model = new FirewallOverviewViewModel()
      model.state.isModeProcessing = true
      const result = await model.requestToggle(context, true)
      expect(result.success).assertFalse()
      expect(result.errorMessage).assertEqual('mode switch in progress')
      expect(scenario.toggles).assertEqual(0)
    })
    it('a thrown mode operation still reloads confirmed state and releases its busy flag', 0, async () => {
      const model = new FirewallOverviewViewModel()
      model.state.currentMode = 'public'
      scenario.rejectSwitch = true
      // A rejected dependency is a public task input. Catch only so the case
      // can inspect the promised state effects, regardless of error transport.
      try { await model.requestModeSwitch(context, 'public') } catch (_) {}
      expect(scenario.switches).assertEqual(1)
      expect(scenario.loads).assertEqual(1)
      expect(model.state.currentMode).assertEqual('custom')
      expect(model.state.enabled).assertTrue()
      expect(model.state.isModeProcessing).assertFalse()
      expect(model.state.isLoading).assertFalse()
    })
    it('a recovered mode exception reports failure through the existing operation result', 0, async () => {
      const model = new FirewallOverviewViewModel()
      scenario.rejectSwitch = true
      // An attempted reload and a returned failure are separate observations.
      // The public caller consumes FirewallOperationResult.success.
      let returnedFailure = false
      try {
        const outcome = await model.requestModeSwitch(context, 'public')
        returnedFailure = outcome.success === false
      } catch (_) {}
      expect(scenario.switches).assertEqual(1)
      expect(returnedFailure).assertTrue()
    })
  })
  publicFirewallRollbackContract()
}
