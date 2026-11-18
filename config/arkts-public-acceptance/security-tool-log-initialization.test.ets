import { describe, expect, it } from '@ohos/hypium'
import { common } from '@kit.AbilityKit'
import { LogEntry, LogEventResult, LogEventType } from '../main/ets/models/DataModels'
import {
  ClearLogsResult,
  CollectorStatus,
  ExportLogsResult,
  InitializeResult,
  LogCollectorStatusPort,
  LogExportServicePort,
  LogQuery,
  LogSnapshot,
  LogStoragePort,
  MutationResult,
  SaveSettingsResult
} from '../main/ets/services/log-manage/common/LogManagePorts'
import { LogManageViewModel } from '../main/ets/viewmodels/log-manage/overview/LogManageViewModel'
import { LogStorageSettingsViewModel } from '../main/ets/viewmodels/log-manage/storage-settings/LogStorageSettingsViewModel'

class RetryLogPorts implements LogStoragePort, LogExportServicePort, LogCollectorStatusPort {
  initCalls: number = 0
  snapshotCalls: number = 0
  private entry: LogEntry = {
    id: 'retry-entry',
    timestamp: 1,
    eventType: LogEventType.FILE,
    result: LogEventResult.SUCCESS,
    detail: 'Synthetic log entry'
  }

  async init(_context: common.UIAbilityContext): Promise<InitializeResult> {
    this.initCalls++
    if (this.initCalls === 1) {
      return { success: false, code: 'storage_init_failed' }
    }
    return { success: true, code: 'ok' }
  }

  async count(_query?: LogQuery): Promise<number> { return 1 }
  async list(_query?: LogQuery, _limit?: number, _offset?: number): Promise<LogEntry[]> { return [this.entry] }
  async hasEntry(entryId: string, _query?: LogQuery): Promise<boolean> { return entryId === this.entry.id }

  async snapshot(_query?: LogQuery, _limit?: number, _offset?: number): Promise<LogSnapshot> {
    this.snapshotCalls++
    return { totalCount: 1, todayCount: 0, blockedCount: 0, filteredCount: 1, entries: [this.entry] }
  }

  async addEntries(_entries: LogEntry[]): Promise<MutationResult> { return { success: false, code: 'save_failed' } }
  async clear(): Promise<ClearLogsResult> { return { success: false, code: 'clear_failed' } }
  addChangeListener(_listener: () => void): number { return 1 }
  removeChangeListener(_id: number): void {}

  async export(_context: common.UIAbilityContext | null, _query?: LogQuery, _fileNamePrefix?: string): Promise<ExportLogsResult> {
    return { success: false, code: 'empty' }
  }

  getStatus(): CollectorStatus {
    return { running: false, auditReady: false, crashReady: false, pendingCount: 0, degraded: false }
  }
}

class RetryLogSettings extends LogStorageSettingsViewModel {
  async load(): Promise<SaveSettingsResult> { return { success: true, code: 'ok' } }
}

export default function publicSecurityToolLogInitializationAcceptance(): void {
  describe('PublicSecurityToolLogInitializationAcceptance', () => {
    it('retries_failed_storage_initialization_and_loads_one_snapshot', 0, async () => {
      const ports = new RetryLogPorts()
      const viewModel = new LogManageViewModel(ports, ports, ports, new RetryLogSettings())
      const context = {} as common.UIAbilityContext

      const first = await viewModel.initialize(context)
      expect(first.success).assertFalse()
      expect(ports.initCalls).assertEqual(1)
      expect(ports.snapshotCalls).assertEqual(0)
      // The page permits another initialization only while this flag is false.
      expect(viewModel.state.initialized).assertFalse()

      const second = await viewModel.initialize(context)
      expect(second.success).assertTrue()
      expect(viewModel.state.initialized).assertTrue()
      expect(ports.initCalls).assertEqual(2)
      expect(ports.snapshotCalls).assertEqual(1)
      expect(viewModel.state.list.pagedEntries.length).assertEqual(1)
      expect(viewModel.state.list.pagedEntries[0].id).assertEqual('retry-entry')
    })
  })
}
