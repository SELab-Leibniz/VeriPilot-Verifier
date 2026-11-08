// Sources: the public task's mutual-exclusion/confirmed-reload requirements,
// and the task-start ViewModel's existing pending-state messages. No evaluator
// cases or reference implementation. Original guards and normal calls are controls;
// the other cases exercise new task requirements, not baseline regressions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@ohos/hypium'
import { common } from '@kit.AbilityKit'
import { ArgumentMatchers, MockKit, when } from '@ohos/hamock'
import { FirewallService } from '../main/ets/services/firewall/FirewallService'
import {
  FirewallOperationResult, FirewallOverviewState, FirewallPresetMode, FirewallToggleOperationResult
} from '../main/ets/services/firewall/FirewallModels'
import { FirewallOverviewViewModel } from '../main/ets/viewmodels/firewall/overview/FirewallOverviewViewModel'

class Scenario {
  rejectSwitch: boolean = false
  switches: number = 0
  toggles: number = 0
  loads: number = 0
}
class ModeSuccess implements FirewallOperationResult { success: boolean = true }
class ToggleSuccess implements FirewallToggleOperationResult {
  success: boolean = true
  targetEnabled: boolean = true
}
class ConfirmedOverview implements FirewallOverviewState {
  enabled: boolean = true
  currentMode: FirewallPresetMode = 'custom'
}
const context = {} as common.UIAbilityContext

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
        return new ModeSuccess()
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
  })
}
