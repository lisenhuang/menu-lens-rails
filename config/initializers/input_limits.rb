# Bound JSON input before Rails' parameter parser runs, including chunked uploads.
class InputLimits
  def initialize(app) = @app=app
  def call(env)
    if env["REQUEST_METHOD"]=="POST" && env["PATH_INFO"].start_with?("/api/")
      max=env["PATH_INFO"].match?(%r{/(upload|read)\z}) ? 16_000_000 : 512_000
      return too_large if env["CONTENT_LENGTH"].to_i>max
      bytes=env["rack.input"].read(max+1)
      return too_large if bytes.bytesize>max
      env["rack.input"]=StringIO.new(bytes)
    end
    @app.call(env)
  end
  def too_large = [413,{"content-type"=>"application/json"},['{"error":"The upload is too large."}']]
end
Rails.application.config.middleware.insert_before 0,InputLimits
