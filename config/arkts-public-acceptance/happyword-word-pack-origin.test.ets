import { describe, expect, it } from '@ohos/hypium'
import {
  BACKEND_ENV_CACHE_KEY,
  BACKEND_PREVIEW_URL_CACHE_KEY,
  latestPackUrl,
  pickServerBaseUrlExplicit,
  PREVIEW_MANIFEST_JSON_URL,
  SERVER_BASE_URL_OVERRIDE_KEY,
  STAGING_BASE_URL,
} from '../main/ets/services/RemoteWordPackConfig'

const manualPreviewUrl: string = 'https://preview.example.invalid'

function restoreStorage(key: string, value: string | undefined): void {
  if (value === undefined) {
    AppStorage.delete(key)
  } else {
    AppStorage.setOrCreate<string>(key, value)
  }
}

function withBackendSelection(env: string, previewUrl: string, check: () => void): void {
  const previousEnv = AppStorage.get<string>(BACKEND_ENV_CACHE_KEY)
  const previousPreview = AppStorage.get<string>(BACKEND_PREVIEW_URL_CACHE_KEY)
  const previousOverride = AppStorage.get<string>(SERVER_BASE_URL_OVERRIDE_KEY)
  try {
    AppStorage.setOrCreate<string>(BACKEND_ENV_CACHE_KEY, env)
    AppStorage.setOrCreate<string>(BACKEND_PREVIEW_URL_CACHE_KEY, previewUrl)
    AppStorage.delete(SERVER_BASE_URL_OVERRIDE_KEY)
    check()
  } finally {
    restoreStorage(BACKEND_ENV_CACHE_KEY, previousEnv)
    restoreStorage(BACKEND_PREVIEW_URL_CACHE_KEY, previousPreview)
    restoreStorage(SERVER_BASE_URL_OVERRIDE_KEY, previousOverride)
  }
}

function assertPreviewManifestUrl(): void {
  expect(PREVIEW_MANIFEST_JSON_URL).assertEqual('https://happyword.cool/api/v1/preview-urls.json')
}

export default function publicHappyWordPackOriginAcceptance(): void {
  describe('PublicHappyWordPackOriginAcceptance', () => {
    it('routes_staging_and_latest_pack_to_happyword_cool', 0, () => {
      expect(STAGING_BASE_URL).assertEqual('https://happyword.cool')
      withBackendSelection('staging', '', () => {
        expect(latestPackUrl()).assertEqual('https://happyword.cool/api/v1/packs/latest.json')
      })
    })

    it('uses_fixed_happyword_cool_preview_manifest', 0, () => {
      withBackendSelection('staging', '', assertPreviewManifestUrl)
      withBackendSelection('local', '', assertPreviewManifestUrl)
      withBackendSelection('preview', manualPreviewUrl, assertPreviewManifestUrl)
    })

    it('preserves_explicit_local_and_preview_routes', 0, () => {
      expect(pickServerBaseUrlExplicit('debug', 'local', '')).assertEqual('http://10.0.2.2:8000')
      expect(pickServerBaseUrlExplicit('debug', 'preview', manualPreviewUrl)).assertEqual(manualPreviewUrl)
    })
  })
}
