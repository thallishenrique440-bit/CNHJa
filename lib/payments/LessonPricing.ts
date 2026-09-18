/**
 * P-1.17 — Derivacao autoritativa do preco da aula (G1).
 *
 * CONTRATO:
 *   O preco da aula e' SEMPRE derivado no servidor a partir de
 *   public.instructor_categories (day_price / night_price), com fallback para
 *   public.instructors (base_price / night_price) quando nao existe linha de
 *   categoria — exatamente a mesma precedencia que a UI usa para EXIBIR o
 *   preco. O `price` que chega no request e' dado NAO CONFIAVEL: serve no
 *   maximo para deteccao de divergencia, nunca para calculo financeiro.
 *
 * ESTE ARQUIVO NAO POSSUI IMPORTS, de proposito: e' puro e testavel sem banco,
 * rede ou credencial. Nao adicionar imports aqui.
 */

/** Linha de public.instructor_categories. */
export interface CategoryPriceRow {
  category: string;
  day_price: number | null;
  night_price: number | null;
}

/** Colunas de preco de public.instructors (fallback legado). */
export interface InstructorPriceFallback {
  base_price: number | null;
  night_price: number | null;
  has_night_lessons: boolean | null;
}

export interface ResolveLessonPriceInput {
  /** 'HH:MM' no fuso ja usado pelo agendamento. */
  startTime: string;
  category: string;
  categoryPrices: CategoryPriceRow[];
  instructor: InstructorPriceFallback;
}

export type PriceSource =
  | 'instructor_categories.day_price'
  | 'instructor_categories.night_price'
  | 'instructors.base_price'
  | 'instructors.night_price';

export interface ResolvedLessonPrice {
  priceCents: number;
  isNight: boolean;
  source: PriceSource;
  /** false quando o preco autoritativo nao pode ser determinado. */
  resolved: boolean;
  reason?: string;
}

/**
 * Regra de turno. Replica literalmente o criterio ja praticado pela UI
 * (InstructorProfile.tsx): a hora inicial define o turno, noite a partir das 18h.
 * Nao inventa faixa nova.
 */
export function isNightSlot(startTime: string): boolean {
  const hour = parseInt(String(startTime || '').split(':')[0], 10);
  return Number.isFinite(hour) && hour >= 18;
}

function isPositiveIntCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/**
 * Precedencia (identica a da UI):
 *   1. linha de instructor_categories da categoria pedida;
 *   2. senao, colunas de instructors.
 * Em ambos, night_price so' se aplica quando o horario e' noturno E o instrutor
 * oferece aulas noturnas.
 *
 * Fail-closed: se o valor resolvido nao for inteiro positivo em centavos,
 * devolve resolved=false. Cobrar um valor indefinido e' pior que recusar.
 */
export function resolveLessonPrice(input: ResolveLessonPriceInput): ResolvedLessonPrice {
  const isNight = isNightSlot(input.startTime);
  const hasNight = input.instructor?.has_night_lessons === true;
  const useNight = isNight && hasNight;

  const row = (input.categoryPrices || []).find(
    c => String(c.category).toUpperCase() === String(input.category).toUpperCase()
  );

  let value: unknown;
  let source: PriceSource;

  if (row) {
    value = useNight ? row.night_price : row.day_price;
    source = useNight ? 'instructor_categories.night_price' : 'instructor_categories.day_price';
  } else {
    value = useNight ? input.instructor?.night_price : input.instructor?.base_price;
    source = useNight ? 'instructors.night_price' : 'instructors.base_price';
  }

  if (!isPositiveIntCents(value)) {
    return {
      priceCents: 0,
      isNight,
      source,
      resolved: false,
      reason: `Preco autoritativo indisponivel em ${source} para a categoria '${input.category}'`
    };
  }

  return { priceCents: value, isNight, source, resolved: true };
}

export interface LessonPriceAudit {
  index: number;
  startTime: string;
  authoritativeCents: number;
  submittedCents: number | null;
  source: PriceSource;
  isNight: boolean;
  diverged: boolean;
}

/**
 * Deriva o preco de cada aula da compra. O valor submetido e' registrado
 * apenas para auditoria de divergencia; nunca entra no calculo.
 */
export function deriveLessonPrices(
  lessons: Array<{ startTime?: string; price?: unknown }>,
  category: string,
  categoryPrices: CategoryPriceRow[],
  instructor: InstructorPriceFallback
): { prices: number[]; audit: LessonPriceAudit[]; unresolved: ResolvedLessonPrice[] } {
  const prices: number[] = [];
  const audit: LessonPriceAudit[] = [];
  const unresolved: ResolvedLessonPrice[] = [];

  (lessons || []).forEach((lesson, index) => {
    const resolved = resolveLessonPrice({
      startTime: String(lesson?.startTime || ''),
      category,
      categoryPrices,
      instructor
    });

    if (!resolved.resolved) {
      unresolved.push(resolved);
      return;
    }

    const submitted = typeof lesson?.price === 'number' && Number.isFinite(lesson.price)
      ? Math.round(lesson.price as number)
      : null;

    prices.push(resolved.priceCents);
    audit.push({
      index,
      startTime: String(lesson?.startTime || ''),
      authoritativeCents: resolved.priceCents,
      submittedCents: submitted,
      source: resolved.source,
      isNight: resolved.isNight,
      diverged: submitted !== null && submitted !== resolved.priceCents
    });
  });

  return { prices, audit, unresolved };
}
