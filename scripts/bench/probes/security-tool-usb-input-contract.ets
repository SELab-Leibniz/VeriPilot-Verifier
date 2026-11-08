// Input and assertions: task-start public connection-record-usb-consumer.test,
// case "U-USB-008 should stay stable for missing or empty raw payloads".
// Vary only a new dependency outcome. This is not an evaluator test or solution.
import { describe, expect, it } from '@ohos/hypium'
import { commonEventManager } from '@kit.BasicServicesKit'
import { ArgumentMatchers, MockKit, when } from '@ohos/hamock'
import { OperationResult, PeripheralType, UsbStoragePolicy } from '../main/ets/models/DataModels'
import { PeripheralService } from '../main/ets/services/peripheral/interface-control/PeripheralService'
import { PeripheralDevicePolicyRepository } from '../main/ets/services/peripheral/device-policy/PeripheralDevicePolicyRepository'
import { PeripheralDevicePolicyDispatchService, PeripheralPolicyDispatchResult } from '../main/ets/services/peripheral/device-policy/peripheral_device_policy_dispatch_service'
import { PeripheralConnectionRecordUsbConsumer } from '../main/ets/services/peripheral/connection-record/peripheral_connection_record_usb_consumer'
import { PeripheralConnectionRecordProducerEvent } from '../main/ets/services/peripheral/connection-record/peripheral_connection_record_producer_contract'

class EmptyParameters {}
class MissingPayload implements PeripheralConnectionRecordProducerEvent {
  source: 'runtime' = 'runtime'
  channel: 'usb' = 'usb'
  eventName: string = commonEventManager.Support.COMMON_EVENT_USB_DEVICE_ATTACHED
  rawData: Object = undefined as never as Object
}
interface RawUsbEvent { event: string; parameters: Object }
class BooleanResult implements OperationResult<boolean> {
  success: boolean = true
  data: boolean = false
}
class StorageResult implements OperationResult<number> {
  success: boolean = true
  data: number = UsbStoragePolicy.READ_WRITE
}
class DispatchSuccess implements PeripheralPolicyDispatchResult {
  success: boolean = true
  message: string = 'Contract probe dependency success'
  stage: string = 'device_policy_dispatch'
}

export default function publicUsbInputContract(): void {
  describe('RCOriginalInputContract', () => {
    it('preserves the public missing or empty payload fallback when the dependency succeeds', 0, async () => {
      await PeripheralDevicePolicyRepository.clearAll()
      const mocks = new MockKit()
      const interfaceState = mocks.mockFunc(PeripheralService, PeripheralService.getInterfaceDisabledWithResult)
      when(interfaceState)(PeripheralService.FEATURE_USB).afterReturn(new BooleanResult())
      const storageState = mocks.mockFunc(PeripheralService, PeripheralService.getUsbStoragePolicyWithResult)
      when(storageState)().afterReturn(new StorageResult())
      // Each method is replaced once, in a separate native process.
      const dispatch = mocks.mockFunc(PeripheralDevicePolicyDispatchService, PeripheralDevicePolicyDispatchService.dispatch)
      when(dispatch)(ArgumentMatchers.any).afterReturn(new DispatchSuccess())
      const raw: RawUsbEvent = {
        event: commonEventManager.Support.COMMON_EVENT_USB_DEVICE_ATTACHED,
        parameters: new EmptyParameters()
      }
      const empty: PeripheralConnectionRecordProducerEvent = {
        source: 'runtime', channel: 'usb', eventName: raw.event, rawData: raw as Object
      }
      const consumer = new PeripheralConnectionRecordUsbConsumer()
      const missingRecord = await consumer.consume(new MissingPayload())
      const emptyRecord = await consumer.consume(empty)
      expect(missingRecord === null).assertTrue()
      expect(emptyRecord !== null).assertTrue()
      expect(emptyRecord?.matchedPolicyKind).assertEqual('default_allow')
      expect(emptyRecord?.deviceType).assertEqual(PeripheralType.USB_OTHER)
    })
  })
}
