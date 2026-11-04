import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';
import { CandidateState } from '../registry/candidate';
import { CommodityData, ProductData, regulationLabel, RegulationData } from '../registry/entities';
import { chargeFor, valueOn } from './charge-engine';
import { BandTableData, lineLabel, RefSeriesData, RefValueData, ScheduleData, ScheduleLineData } from './tariff-entities';

/** Published reference prices, band tables and duty/levy schedules (latest data version only). */
@Injectable()
export class TariffReadService {
  constructor(private readonly db: DbService) {}

  /** Every series with the value in force on `date` and the latest value (US-27-N2: a missing month is visible). */
  async series(date: string) {
    const state = await CandidateState.load(this.db.pool);
    return state.ofType<RefSeriesData>('REF_SERIES')
      .sort((a, b) => a.data.kind.localeCompare(b.data.kind) || a.data.code.localeCompare(b.data.code))
      .map((s) => {
        const latest = state.ofType<RefValueData>('REF_VALUE').filter((v) => v.data.seriesId === s.id)
          .sort((a, b) => b.data.periodTo.localeCompare(a.data.periodTo))[0];
        return {
          entityId: s.id,
          ...s.data,
          product: s.data.productId ? (state.get<ProductData>(s.data.productId, 'PRODUCT')?.nameId ?? null) : null,
          current: valueOn(state, s.id, date),
          latest: latest ? { valueId: latest.id, ...latest.data } : null,
        };
      });
  }

  /** Published values of one series, newest first, each with its source decree. */
  async values(seriesId: string) {
    const state = await CandidateState.load(this.db.pool);
    const series = state.get<RefSeriesData>(seriesId, 'REF_SERIES');
    if (!series) throw new ApiError(404, 'NOT_FOUND', 'Series not found.');
    const values = state.ofType<RefValueData>('REF_VALUE').filter((v) => v.data.seriesId === seriesId)
      .sort((a, b) => b.data.periodFrom.localeCompare(a.data.periodFrom));
    const { rows: docs } = await this.db.query<{ id: string; title: string; sha256: string; publisher: string | null }>(
      `SELECT d.id, d.title, encode(d.sha256, 'hex') AS sha256, p.name AS publisher
         FROM ecr.source_document d LEFT JOIN ecr.source_publisher p ON p.id = d.publisher_id WHERE d.id = ANY($1::uuid[])`,
      [values.map((v) => v.data.sourceDocumentId).filter(Boolean)],
    );
    const docOf = new Map(docs.map((d) => [d.id, d]));
    return {
      entityId: seriesId,
      ...series,
      product: series.productId ? (state.get<ProductData>(series.productId, 'PRODUCT')?.nameId ?? null) : null,
      values: values.map((v) => ({ entityId: v.id, ...v.data, sourceDocument: docOf.get(v.data.sourceDocumentId ?? '') ?? null })),
    };
  }

  async bandTables() {
    const state = await CandidateState.load(this.db.pool);
    return state.ofType<BandTableData>('BAND_TABLE').sort((a, b) => a.data.code.localeCompare(b.data.code)).map((t) => ({
      entityId: t.id,
      ...t.data,
      refSeries: state.get<RefSeriesData>(t.data.refSeriesId, 'REF_SERIES')?.code ?? null,
    }));
  }

  async schedules(chargeType?: string) {
    const state = await CandidateState.load(this.db.pool);
    const lines = state.ofType<ScheduleLineData>('SCHEDULE_LINE');
    return state.ofType<ScheduleData>('SCHEDULE')
      .filter((s) => !chargeType || s.data.chargeType === chargeType)
      .map((s) => this.scheduleSummary(state, s.id, s.data, lines.filter((l) => l.data.scheduleId === s.id).length))
      .sort((a, b) => a.chargeType.localeCompare(b.chargeType) || (a.regulation ?? '').localeCompare(b.regulation ?? ''));
  }

  async schedule(entityId: string) {
    const state = await CandidateState.load(this.db.pool);
    const schedule = state.get<ScheduleData>(entityId, 'SCHEDULE');
    if (!schedule) throw new ApiError(404, 'NOT_FOUND', 'Schedule not found.');
    const lines = state.ofType<ScheduleLineData>('SCHEDULE_LINE').filter((l) => l.data.scheduleId === entityId)
      .sort((a, b) => `${a.data.kelompok ?? ''} ${a.data.itemNo ?? ''}`.localeCompare(`${b.data.kelompok ?? ''} ${b.data.itemNo ?? ''}`, undefined, { numeric: true }));
    return {
      ...this.scheduleSummary(state, entityId, schedule, lines.length),
      lines: lines.map((l) => {
        const table = state.get<BandTableData>(l.data.bandTableId, 'BAND_TABLE');
        return {
          entityId: l.id,
          label: lineLabel(l.data),
          ...l.data,
          refSeries: state.get<RefSeriesData>(l.data.refSeriesId, 'REF_SERIES')?.code ?? null,
          bandTable: table ? { code: table.code, bands: table.bands } : null,
          products: l.data.productIds.map((p) => ({ entityId: p, nameId: state.get<ProductData>(p, 'PRODUCT')?.nameId ?? 'Unregistered product' })),
        };
      }),
    };
  }

  /** BK and PE for one product on a date, with the legal basis and the values used (PRD FR-CAT-05). */
  async productCharges(productId: string, date: string) {
    const state = await CandidateState.load(this.db.pool);
    return { date, bk: chargeFor(state, productId, 'BK', date), pe: chargeFor(state, productId, 'PE', date) };
  }

  private scheduleSummary(state: CandidateState, id: string, s: ScheduleData, lineCount: number) {
    const regulation = state.get<RegulationData>(s.regulationId, 'REGULATION');
    return {
      entityId: id,
      ...s,
      regulation: regulation ? regulationLabel(regulation) : null,
      commodity: state.get<CommodityData>(s.commodityId, 'COMMODITY')?.code ?? null,
      lineCount,
    };
  }
}
