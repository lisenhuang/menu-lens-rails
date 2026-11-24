module Objects
  module_function
  def request(key, method: :get, body: nil, type: "application/octet-stream")
    raise ArgumentError unless key.match?(%r{\A(dishes|originals|site|data)/(?:[\w-][\w.-]*/)*[\w-][\w.-]*\z})
    tries = 0
    begin
      reply = HttpClient.call(URI.join(ENV.fetch("R2_GATEWAY_URL"),key).to_s, method: method, body: body,
        headers: {"Authorization"=>"Bearer " + ENV.fetch("R2_GATEWAY_SECRET"), "Content-Type"=>type})
      return reply.body if reply.is_a?(Net::HTTPSuccess)
      raise Problem.new(404,"File not found.") if reply.code == "404"
      raise IOError, "Object storage unavailable" if reply.code.to_i >= 500 || reply.code == "429"
      raise Problem.new(502,"Object storage request failed.")
    rescue IOError, SystemCallError, Timeout::Error
      tries += 1
      raise if tries >= 3
      sleep(tries * 0.3)
      retry
    end
  end
  def exists?(key)
    request(key, method: :head)
    true
  rescue Problem => error
    raise unless error.status == 404
    false
  end
end
