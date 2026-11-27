module BillingBalance
  MINIMUM_USD = 10

  class Paused < Problem
    def initialize
      super(503, "AI generation is temporarily paused. Please try again later.")
    end
  end

  class ProviderBlocked < Paused; end

  module_function

  def snapshot
    args = []
    if CreditBalanceFeed.configured?
      args = [
        Store.now - CreditBalanceFeed::OUTAGE_GRACE.to_i * 1000,
        (Time.now.utc - CreditBalanceFeed.max_age).iso8601(3),
        Store.sha(CreditBalanceFeed.url)
      ]
      source = <<~SQL
        SELECT cents, 'Balance feed' AS organization, checked,
               CASE WHEN fetched_at < ? THEN 'unreachable' WHEN checked < ? THEN 'stale' ELSE 'current' END AS feed_status
        FROM billing_feed_snapshots WHERE source = ?
      SQL
    else
      source = "SELECT cents, organization, checked, 'manual' AS feed_status FROM billing_snapshot WHERE id=1"
    end
    Store.first(<<~SQL, *args)
      WITH baseline AS (#{source}), charges AS (
        SELECT c.seq, COALESCE(c.usd, h.reserved_usd) AS usd, h.exhausted
        FROM generation_calls c
        LEFT JOIN billing_call_holds h ON h.call_seq = c.seq
        CROSS JOIN baseline s
        WHERE c.state = 'running'
           OR julianday(COALESCE(h.finished, c.started)) >= julianday(s.checked)
      )
      SELECT s.cents, s.organization, s.checked, s.feed_status, COALESCE(MAX(charges.exhausted), 0) AS provider_blocked,
        CASE WHEN s.feed_status IN ('current','manual') AND typeof(s.cents) = 'integer' AND julianday(s.checked) <= julianday('now')
          AND COUNT(charges.seq) = COUNT(charges.usd)
          THEN ROUND(s.cents / 100.0 - COALESCE(SUM(charges.usd), 0), 9)
      END AS remaining
      FROM baseline s LEFT JOIN charges ON TRUE
      GROUP BY s.checked
    SQL
  end

  def available?
    row = snapshot
    !!(row && row["provider_blocked"].zero? && row["remaining"] && row["remaining"] >= MINIMUM_USD)
  end

  def check!
    raise Paused unless available?
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
    raise Paused unless estimate
    Store.sql("INSERT INTO billing_call_holds(call_seq, reserved_usd) VALUES (?, ?)", seq, estimate)
  end
end
