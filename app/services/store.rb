module Store
  module_function
  def now = (Time.now.to_r * 1000).to_i
  def stamp = Time.now.utc.iso8601(3)
  def sha(value) = Digest::SHA256.hexdigest(value)
  def submission_id(owner) = sha("menu-lens/submission/" + owner)[0,20]
  def normalize(value) = value.to_s.unicode_normalize(:nfkc).downcase.gsub(/[^\p{L}\p{N}]+/, " ").strip
  def search(value) = normalize(value.to_s.unicode_normalize(:nfkd).gsub(/\p{M}/, ""))
  def connection(&block) = ActiveRecord::Base.connection_pool.with_connection(&block)
  def sql(query, *args)
    connection { |conn| conn.raw_connection.execute(query, args) }
  end
  def first(query, *args) = sql(query, *args).first
  def transaction(&block) = ApplicationRecord.transaction(&block)
  def clean(value, max, label)
    raise Problem.new(400, "#{label} is missing or exceeds the supported length.") unless value.is_a?(String) && value.length <= max
    value.gsub(/\r\n?/, "\n").strip
  end
  def capacity!(key, limit, ttl)
    time = now
    row = first(<<~SQL, key, time + ttl, time, time, time, limit)
      INSERT INTO counters(id,count,expires) VALUES (?,1,?)
      ON CONFLICT(id) DO UPDATE SET count=CASE WHEN counters.expires<=? THEN 1 ELSE count+1 END,
        expires=CASE WHEN counters.expires<=? THEN excluded.expires ELSE counters.expires END
      WHERE counters.expires<=? OR count<? RETURNING count
    SQL
    raise Problem.new(429, "Too many requests. Please try again later.") unless row
  end
  def ready? = %w[R2_GATEWAY_URL R2_GATEWAY_SECRET OPENAI_API_KEY TURNSTILE_SITE_KEY TURNSTILE_SECRET TURNSTILE_HOSTNAME].all? { |key| ENV[key].present? }
end
