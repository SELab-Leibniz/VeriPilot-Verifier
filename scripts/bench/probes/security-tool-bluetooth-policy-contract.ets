import { afterEach, beforeEach, describe, expect, it } from '@ohos/hypium'
import { ArgumentMatchers, MockKit, when } from '@ohos/hamock'
import { PeripheralReasonCodes } from '../main/ets/constants/modules/PeripheralStrings'
import { PeripheralDevicePolicyRecord, PeripheralType } from '../main/ets/models/PeripheralModels'
import { PeripheralDevicePolicyRepository } from '../main/ets/services/peripheral/device-policy/PeripheralDevicePolicyRepository'
import {
  PeripheralDevicePolicyDispatchService,
  PeripheralPolicyDispatchResult
} from '../main/ets/services/peripheral/device-policy/peripheral_device_policy_dispatch_service'
import { PeripheralPolicyViewModel } from '../main/ets/viewmodels/peripheral/device-policy/PeripheralPolicyViewModel'

// The task-start ViewModel tests substitute the dispatcher and observe local writes.
export default function publicBluetoothPolicyContract(): void {
  describe('RCPublicBluetoothDispatch', () => {
    it('the real dispatcher rejects Bluetooth as unsupported', 0, async () => {
      const result = await PeripheralDevicePolicyDispatchService.dispatch({
        deviceId: 'MAC: 12:34:56:78:9A:BC',
        deviceType: PeripheralType.BLUETOOTH,
        policy: 'allow'
      })
      expect(result.success).assertFalse()
      expect(result.reason).assertEqual(PeripheralReasonCodes.UNSUPPORTED_DEVICE_TYPE_DISPATCH)
    })
  })

  describe('RCPublicPeripheralPolicySaveBoundary', () => {
    let mocks: MockKit
    let writes: PeripheralDevicePolicyRecord[]

    beforeEach(() => {
      mocks = new MockKit()
      writes = []
      const dispatched: PeripheralPolicyDispatchResult = { success: true }
      const dispatch = mocks.mockFunc(PeripheralDevicePolicyDispatchService, PeripheralDevicePolicyDispatchService.dispatch)
      when(dispatch)(ArgumentMatchers.any).afterReturn(dispatched)
      const save = mocks.mockFunc(PeripheralDevicePolicyRepository, PeripheralDevicePolicyRepository.set)
      when(save)(ArgumentMatchers.any).afterAction((record: PeripheralDevicePolicyRecord) => {
        writes.push(record)
        return Promise.resolve(true)
      })
    })

    afterEach(() => {
      mocks.clear(PeripheralDevicePolicyDispatchService)
      mocks.clear(PeripheralDevicePolicyRepository)
      mocks.clearAll()
    })

    it('USB still saves a policy when dispatch succeeds', 0, async () => {
      const result = await new PeripheralPolicyViewModel().setDevicePolicy(
        'VID:3456 PID:789A', 'USB storage', PeripheralType.USB_STORAGE, 1
      )
      expect(result).assertNull()
      expect(writes.length).assertEqual(1)
      expect(writes[0].policy).assertEqual('deny')
    })

    it('a successful dispatch substitute cannot permit a Bluetooth policy write', 0, async () => {
      const result = await new PeripheralPolicyViewModel().setDevicePolicy(
        '12:34:56:78:9A:BC', 'Bluetooth keyboard', PeripheralType.BLUETOOTH, 1
      )
      expect(writes.length).assertEqual(0)
      expect(result).assertEqual(PeripheralReasonCodes.UNSUPPORTED_DEVICE_TYPE_DISPATCH)
    })
  })
}
