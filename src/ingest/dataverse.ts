import type { RawAiEvent } from '../types.js';
import type { TokenProvider } from '../auth/token.js';

const API = 'api/data/v9.2';
const MAX_RETRIES = 6;

interface ODataResponse {
  value: Record<string, unknown>[];
  '@odata.nextLink'?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET all pages of an OData query, honoring 429/503 Retry-After. */
export async function odataGetAll(
  firstUrl: string,
  token: string,
  onPage?: (fetched: number) => void
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let url: string | undefined = firstUrl;

  while (url) {
    let response: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          Prefer:
            'odata.maxpagesize=5000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
        },
      });
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 10;
        if (attempt === MAX_RETRIES) {
          throw new Error(`Throttled (${response.status}) after ${MAX_RETRIES} retries: ${url}`);
        }
        await sleep(retryAfter * 1000);
        continue;
      }
      break;
    }
    if (!response) throw new Error('No response received.');
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Dataverse request failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
    }
    const page = (await response.json()) as ODataResponse;
    rows.push(...page.value);
    onPage?.(rows.length);
    url = page['@odata.nextLink'];
  }
  return rows;
}

/** AI model id -> { name, templateName } for capability matching. Degrades gracefully. */
export async function fetchModelMap(
  environmentUrl: string,
  token: string
): Promise<Map<string, { name: string | null; templateName: string | null }>> {
  const map = new Map<string, { name: string | null; templateName: string | null }>();
  const base = `${environmentUrl}/${API}/msdyn_aimodels`;
  try {
    const rows = await odataGetAll(
      `${base}?$select=msdyn_name&$expand=msdyn_TemplateId($select=msdyn_name)`,
      token
    );
    for (const row of rows) {
      const template = row['msdyn_TemplateId'] as Record<string, unknown> | null | undefined;
      map.set(String(row['msdyn_aimodelid']), {
        name: (row['msdyn_name'] as string | null) ?? null,
        templateName: template ? ((template['msdyn_name'] as string | null) ?? null) : null,
      });
    }
  } catch {
    // Template expand can fail on locked-down roles; retry without it.
    try {
      const rows = await odataGetAll(`${base}?$select=msdyn_name`, token);
      for (const row of rows) {
        map.set(String(row['msdyn_aimodelid']), {
          name: (row['msdyn_name'] as string | null) ?? null,
          templateName: null,
        });
      }
    } catch {
      // No model access at all: matching falls back to event name + eventdata.
    }
  }
  return map;
}

/** Map one Dataverse msdyn_aievents row to RawAiEvent. Exported for tests. */
export function mapEventRow(
  row: Record<string, unknown>,
  environmentUrl: string,
  modelMap: Map<string, { name: string | null; templateName: string | null }>
): RawAiEvent {
  const modelId = row['_msdyn_aimodelid_value'] as string | null | undefined;
  const model = modelId ? modelMap.get(modelId) : undefined;
  return {
    id: String(row['msdyn_aieventid']),
    name: (row['msdyn_name'] as string | null) ?? null,
    processingDate: String(row['msdyn_processingdate'] ?? ''),
    processingStatus:
      row['msdyn_processingstatus'] === null || row['msdyn_processingstatus'] === undefined
        ? null
        : Number(row['msdyn_processingstatus']),
    consumptionSource:
      row['msdyn_consumptionsource'] === null || row['msdyn_consumptionsource'] === undefined
        ? null
        : Number(row['msdyn_consumptionsource']),
    creditConsumed: Number(row['msdyn_creditconsumed'] ?? 0),
    quickTest: row['msdyn_quicktest'] === true,
    modelName: model?.name ?? null,
    templateName: model?.templateName ?? null,
    automationName: (row['msdyn_automationname'] as string | null) ?? null,
    userId: (row['_createdby_value'] as string | null) ?? null,
    userName:
      (row['_createdby_value@OData.Community.Display.V1.FormattedValue'] as string | null) ?? null,
    eventData: (row['msdyn_eventdata'] as string | null) ?? null,
    environmentUrl,
  };
}

/** Pull AI events since a given date. READ-ONLY (GET only). */
export async function fetchAiEvents(
  environmentUrl: string,
  tokenProvider: TokenProvider,
  sinceIsoDate: string,
  onProgress?: (fetched: number) => void
): Promise<RawAiEvent[]> {
  const token = await tokenProvider(environmentUrl);
  const modelMap = await fetchModelMap(environmentUrl, token);

  const select = [
    'msdyn_aieventid',
    'msdyn_name',
    'msdyn_processingdate',
    'msdyn_processingstatus',
    'msdyn_consumptionsource',
    'msdyn_creditconsumed',
    'msdyn_quicktest',
    'msdyn_automationname',
    'msdyn_eventdata',
    '_msdyn_aimodelid_value',
    '_createdby_value',
  ].join(',');
  const url =
    `${environmentUrl}/${API}/msdyn_aievents` +
    `?$select=${select}` +
    `&$filter=msdyn_processingdate ge ${sinceIsoDate}` +
    `&$orderby=msdyn_processingdate asc`;

  const rows = await odataGetAll(url, token, onProgress);
  return rows.map((row) => mapEventRow(row, environmentUrl, modelMap));
}
