import axios from 'axios';
import { ApiResponse, ProcessedCampaignData, PIInfo } from '../types/campaign';
import { parse } from 'date-fns';

// Cada fonte de dados tem seu próprio layout de colunas, então cada uma
// precisa de um mapeador específico que converte uma linha em ProcessedCampaignData.
interface CampaignSource {
  url: string;
  mapRow: (row: string[]) => ProcessedCampaignData | null;
}

const parseNumber = (value: string): number => {
  if (!value || value === '') return 0;
  const cleaned = value.replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
};

const parseCurrency = (value: string): number => {
  if (!value || value === '') return 0;
  // Remove "R$" e espaços, depois processa como número
  const cleaned = value.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
};


const parseSearchDate = (dateString: string): Date => {
  try {
    if (!dateString) return new Date();
    // Formato dd/MM/yyyy (ex: "18/06/2025")
    if (dateString.includes('/')) {
      return parse(dateString, 'dd/MM/yyyy', new Date());
    }
    // Formato yyyy-MM-dd (fallback)
    return parse(dateString, 'yyyy-MM-dd', new Date());
  } catch {
    return new Date();
  }
};

const normalizeVeiculo = (veiculo: string): string => {
  const normalized = veiculo.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'audience network' || lower === 'messenger' || lower === 'threads' || lower === 'unknown') {
    return 'Facebook';
  }
  return normalized;
};

// Layout "Consolidado", comum às planilhas da agência (índice → campo):
// [0] Nome Conta, [1] ID Conta, [2] Data, [3] Device, [4] Campaign Name, [5] Campaign ID,
// [6] Ad Group Name, [7] Ad group ID, [8] Ad Name, [9] Ad ID, [10] Ad Final URL,
// [11] Cost (Spend), [12] Impressions, [13] Clicks, [14] Video View, [15] Views 25%,
// [16] Views 50%, [17] Views 75%, [18] Views 100%, [19] VA, [20] Agência, [21] Veículo,
// [22] Número PI, [23] Tipo de Compra, [24] Investimento, [25] Formato, [26] Campanha.
// A partir daí as planilhas divergem: a original traz [27] Localização e [28] Cliente;
// a do Ministério da Saúde não tem Localização, então Cliente cai em [27]. Só esse índice
// muda, então o mapeador é criado com a posição da coluna Cliente de cada fonte.
const createConsolidadoMapper = (clienteIndex: number) => (row: string[]): ProcessedCampaignData | null => {
  if (row.length < 14) return null;
  const numeroPi = row[22] || '';
  if (numeroPi === '#VALUE!') return null;

  // "VA" nesta planilha chega como percentual de visibilidade (ex.: "66.65%"),
  // não como contagem de engajamento — então não entra no total de engajamento.
  const vaRaw = row[19] || '';
  const engajamento = vaRaw.includes('%') ? 0 : parseNumber(vaRaw);

  return {
    date: parseSearchDate(row[2]),
    campaignName: row[4] || '',
    adSetName: row[6] || '',
    adName: row[8] || '',
    cost: parseCurrency(row[24]),
    impressions: parseNumber(row[12]),
    reach: 0,
    clicks: parseNumber(row[13]),
    videoViews: parseNumber(row[14]),
    videoViews25: parseNumber(row[15]),
    videoViews50: parseNumber(row[16]),
    videoViews75: parseNumber(row[17]),
    videoCompletions: parseNumber(row[18]),
    totalEngagements: engajamento,
    veiculo: normalizeVeiculo(row[21] || ''),
    tipoDeCompra: row[23] || '',
    videoEstaticoAudio: row[25] || '',
    image: '',
    campanha: row[26] || '',
    numeroPi,
    cliente: row[clienteIndex] || '',
    agencia: row[20] || ''
  };
};

const CAMPAIGN_SOURCES: CampaignSource[] = [
  {
    url: 'https://nmbcoamazonia-api.vercel.app/google/sheets/1MSRuhOMQcMsG6wntr76CS2c-Q8xTl81U6Rncwka0muw/data?range=Consolidado',
    mapRow: createConsolidadoMapper(28)
  },
  // Ministério da Saúde
  {
    url: 'https://nmbcoamazonia-api.vercel.app/google/sheets/1Wn5gD-lrQB9aGqjxCFYU2H9OYKRzUAbJUQoSNppa1-A/data?range=Consolidado',
    mapRow: createConsolidadoMapper(27)
  }
];

export const fetchCampaignData = async (): Promise<ProcessedCampaignData[]> => {
  try {
    const responses = await Promise.allSettled(
      CAMPAIGN_SOURCES.map(source => axios.get<ApiResponse>(source.url))
    );

    const allData: ProcessedCampaignData[] = [];

    responses.forEach((response, index) => {
      if (response.status !== 'fulfilled') {
        console.error('Erro ao buscar fonte de campanhas:', CAMPAIGN_SOURCES[index].url, response.reason);
        return;
      }

      const { mapRow } = CAMPAIGN_SOURCES[index];
      const payload = response.value.data;

      if (payload.success && payload.data.values.length > 1) {
        payload.data.values.slice(1).forEach(row => {
          const mapped = mapRow(row);
          if (mapped) allData.push(mapped);
        });
      }
    });

    return allData;
  } catch (error) {
    console.error('Erro ao buscar dados das campanhas:', error);
    throw error;
  }
};

const PI_INFO_BASE_URL = 'https://nmbcoamazonia-api.vercel.app/google/sheets/1T35Pzw9ZA5NOTLHsTqMGZL5IEedpSGdZHJ2ElrqLs1M/data';
const PI_INFO_API_URL = `${PI_INFO_BASE_URL}?range=base`;
const PI_INFO_REPRESENTACAO_URL = `${PI_INFO_BASE_URL}?range=representacao`;

// [0] Agência, [1] Cliente, [2] Número PI, [3] Veículo, [4] Canal, [5] Formato,
// [6] Modelo Compra, [7] Valor Uni, [8] Desconto, [9] Valor Negociado, [10] Qtd,
// [11] TT Bruto, [12] Reaplicação, [13] Status, [14] Segmentação, [15] Alcance,
// [16] Inicio, [17] Fim, [18] Público, [19] Praça, [20] Objetivo
const mapBaseRow = (row: string[]): PIInfo => ({
  numeroPi: row[2] || '',
  veiculo: row[3] || '',
  canal: row[4] || '',
  formato: row[5] || '',
  modeloCompra: row[6] || '',
  valorNegociado: row[9] || '',
  quantidade: row[10] || '',
  totalBruto: row[11] || '',
  status: row[13] || '',
  segmentacao: row[14] || '',
  alcance: row[15] || '',
  inicio: row[16] || '',
  fim: row[17] || '',
  publico: row[18] || '',
  praca: row[19] || '',
  objetivo: row[20] || ''
});

const mapRepresentacaoRow = (row: string[]): PIInfo => ({
  numeroPi: row[2] || '',
  veiculo: row[3] || '',
  canal: '',
  formato: row[4] || '',
  modeloCompra: row[5] || '',
  valorNegociado: row[12] || '',
  quantidade: row[10] || '',
  totalBruto: row[14] || '',
  status: '',
  segmentacao: row[6] || '',
  alcance: row[7] || '',
  inicio: row[8] || '',
  fim: row[9] || '',
  publico: '',
  praca: row[15] || '',
  objetivo: row[16] || ''
});

export const fetchPIInfo = async (numeroPi: string): Promise<PIInfo[] | null> => {
  try {
    const normalizedPi = numeroPi.replace(/^0+/, '').replace(/\./g, '').replace(',', '.');

    const [baseRes, reprRes] = await Promise.allSettled([
      axios.get(PI_INFO_API_URL),
      axios.get(PI_INFO_REPRESENTACAO_URL)
    ]);

    const piInfo: PIInfo[] = [];

    if (baseRes.status === 'fulfilled' && baseRes.value.data.success && baseRes.value.data.data.values) {
      const rows: string[][] = baseRes.value.data.data.values.slice(1);
      rows
        .filter(row => (row[2] || '').replace(/^0+/, '').replace(/\./g, '').replace(',', '.') === normalizedPi)
        .forEach(row => piInfo.push(mapBaseRow(row)));
    }

    if (reprRes.status === 'fulfilled' && reprRes.value.data.success && reprRes.value.data.data.values) {
      const rows: string[][] = reprRes.value.data.data.values.slice(1);
      rows
        .filter(row => (row[2] || '').replace(/^0+/, '').replace(/\./g, '').replace(',', '.') === normalizedPi)
        .forEach(row => piInfo.push(mapRepresentacaoRow(row)));
    }

    return piInfo.length > 0 ? piInfo : null;
  } catch (error) {
    console.error('Erro ao buscar informações do PI:', error);
    return null;
  }
};

