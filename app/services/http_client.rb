require "net/http"
module HttpClient
  module_function
  def call(url, method: :get, body: nil, headers: {}, timeout: 25, max_bytes: nil)
    uri = URI(url)
    request = Net::HTTP.const_get(method.to_s.capitalize).new(uri, headers)
    request.body = body if body
    # Never replay paid provider requests after a lost response.
    http = Net::HTTP.new(uri.hostname, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = 8
    http.read_timeout = http.write_timeout = timeout
    http.max_retries = 0
    return http.request(request) unless max_bytes

    bytes = +"".b
    http.request(request) do |response|
      response.read_body do |chunk|
        raise IOError, "Response exceeds size limit" if bytes.bytesize + chunk.bytesize > max_bytes
        bytes << chunk
      end
      response.body = bytes
    end
  end
end
