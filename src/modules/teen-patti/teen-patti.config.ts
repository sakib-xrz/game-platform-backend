import {
  TEEN_PATTI_MIN_RESULT_DURATION_MS,
  TEEN_PATTI_REQUIRED_DECKS,
} from './teen-patti.constant';

export type StoredTeenPattiConfigForPublish = {
  result_duration_ms: number;
  min_bet: bigint;
  max_single_bet: bigint;
  options: ReadonlyArray<{ is_enabled: boolean }>;
  chip_values: ReadonlyArray<{ amount: bigint; is_enabled: boolean }>;
};

export type TeenPattiConfigInvariantFailure = {
  field: 'options' | 'chip_values' | 'result_duration_ms';
  message: string;
};

/** Revalidates persisted rows at both approval boundaries. */
export const getTeenPattiPublishInvariantFailures = (
  config: StoredTeenPattiConfigForPublish,
): TeenPattiConfigInvariantFailure[] => {
  const failures: TeenPattiConfigInvariantFailure[] = [];
  const enabled_options = config.options.filter((option) => option.is_enabled);
  const enabled_chips = config.chip_values.filter((chip) => chip.is_enabled);

  if (enabled_options.length !== TEEN_PATTI_REQUIRED_DECKS) {
    failures.push({
      field: 'options',
      message: `exactly ${TEEN_PATTI_REQUIRED_DECKS} options must be enabled`,
    });
  }
  if (!enabled_chips.length) {
    failures.push({
      field: 'chip_values',
      message: 'at least one chip must be enabled',
    });
  } else if (
    enabled_chips.some(
      (chip) =>
        chip.amount < config.min_bet ||
        chip.amount > config.max_single_bet,
    )
  ) {
    failures.push({
      field: 'chip_values',
      message: 'every enabled chip must be between min_bet and max_single_bet',
    });
  }
  if (config.result_duration_ms < TEEN_PATTI_MIN_RESULT_DURATION_MS) {
    failures.push({
      field: 'result_duration_ms',
      message: `result_duration_ms must be at least ${TEEN_PATTI_MIN_RESULT_DURATION_MS}`,
    });
  }

  return failures;
};

/** Legacy published configs are clamped without mutating their audit record. */
export const effectiveTeenPattiResultDurationMs = (
  configured_duration_ms: number,
): number =>
  Math.max(configured_duration_ms, TEEN_PATTI_MIN_RESULT_DURATION_MS);
