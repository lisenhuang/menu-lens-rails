module BillingBalance
  MINIMUM_USD = 10

  class Paused < Problem
    def initialize
      super(503, "AI generation is temporarily paused. Please try again later.")
    end
  end

  class Exhausted < Paused; end

  module_function

  def remaining_usd
    Store.first(<<~SQL)&.fetch("remaining")
      WITH charges AS (
        SELECT c.seq, COALESCE(c.usd, h.reserved_usd) AS usd, h.exhausted
        FROM generation_calls c
        LEFT JOIN billing_call_holds h ON h.call_seq = c.seq
        JOIN billing_snapshot s ON s.id = 1
        WHERE c.state = 'running'
           OR julianday(COALESCE(h.finished, c.started)) >= julianday(s.checked)
      )
      SELECT CASE
        WHEN MAX(charges.exhausted) = 1 THEN 0
        WHEN COUNT(charges.seq) = COUNT(charges.usd)
          THEN ROUND(s.cents / 100.0 - COALESCE(SUM(charges.usd), 0), 9)
      END AS remaining
      FROM billing_snapshot s LEFT JOIN charges ON TRUE
      WHERE s.id = 1 AND typeof(s.cents) = 'integer' AND julianday(s.checked) <= julianday('now')
      GROUP BY s.id
    SQL
  end

  def check!
    remaining = remaining_usd
    raise Paused unless remaining && remaining >= MINIMUM_USD
  end

  # Hold an estimated output charge while usage is outstanding. Keep it if the
  # provider never returns usage, including when a worker is interrupted.
  def reserve(seq, kind, model, level)
    estimate = case kind
    when "image"
      GenerationHistory.price(kind, model, level, nil, true).first
    when "read", "address"
      rate = Settings::READERS.dig(model, "output")
      tokens = kind == "read" ? Providers::READ_OUTPUT_TOKENS : Providers::ADDRESS_OUTPUT_TOKENS
      tokens * rate / 1e6 + (kind == "address" ? Providers::ADDRESS_SEARCH_LIMIT * 0.01 : 0) if rate
    end
    Store.sql("INSERT INTO billing_call_holds(call_seq, reserved_usd) VALUES (?, ?)", seq, estimate)
  end
end
