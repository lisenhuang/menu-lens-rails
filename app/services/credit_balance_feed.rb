require "bigdecimal"

module CreditBalanceFeed
  POLL_SECONDS = 60
  OUTAGE_GRACE = 5.minutes
  module_function

  def url = ENV["CREDIT_BALANCE_FEED_URL"].presence
  def configured? = url.present?

  def max_age
    seconds = Integer(ENV.fetch("CREDIT_BALANCE_MAX_AGE_SECONDS", "86400"), 10)
    raise ArgumentError, "Invalid credit balance freshness interval" unless seconds.positive?
    seconds
  end

  def start
    return unless configured? && ENV["MENU_WORKERS"] != "off"
    poll
    Thread.new do
      loop do
        sleep POLL_SECONDS
        poll
      end
    end
  end

  def poll
    Rails.application.executor.wrap { refresh! }
  rescue StandardError => error
    Rails.logger.warn("Credit balance refresh failed (#{error.class})")
  end

  def refresh!
    endpoint = url
    uri = URI.parse(endpoint)
    raise ArgumentError, "Expected an HTTPS balance feed" unless uri.is_a?(URI::HTTPS) && uri.host.present? && !uri.userinfo && !uri.fragment
    reply = HttpClient.call(endpoint, headers: {"Accept"=>"application/json", "Cache-Control"=>"no-cache"}, timeout: 8, max_bytes: 4096)
    raise IOError, "Balance feed unavailable" unless reply.is_a?(Net::HTTPSuccess) && reply.content_type == "application/json"
    report = JSON.parse(reply.body, decimal_class: BigDecimal)
    raise ArgumentError, "Invalid balance report" unless report.is_a?(Hash)
    balance, timestamp = report.values_at("balance", "timestamp")
    unless (balance.is_a?(Integer) || balance.is_a?(BigDecimal)) && balance.finite? && balance.abs < 10**12
      raise ArgumentError, "Invalid USD balance"
    end
    raise ArgumentError, "Expected a timestamp with a time zone" unless timestamp.is_a?(String) && timestamp.match?(/(?:Z|[+-]\d\d:\d\d)\z/)
    observed = Time.iso8601(timestamp)
    raise ArgumentError, "Future balance report" if observed > Time.now

    # An unchanged observation confirms reachability without moving the ledger cutoff.
    row = Store.first(<<~SQL, Store.sha(endpoint), (balance * 100).floor, observed.utc.iso8601(3), Store.now)
      INSERT INTO billing_feed_snapshots(source, cents, checked, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET cents=excluded.cents, checked=excluded.checked, fetched_at=excluded.fetched_at
      WHERE excluded.checked > billing_feed_snapshots.checked
         OR (excluded.checked = billing_feed_snapshots.checked AND excluded.cents = billing_feed_snapshots.cents)
      RETURNING source
    SQL
    raise ArgumentError, "Outdated or conflicting balance report" unless row
  end
end
