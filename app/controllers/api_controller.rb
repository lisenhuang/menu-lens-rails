class ApiController < ApplicationController
  before_action :same_origin, if: -> { request.post? }
  rescue_from BillingBalance::Paused do |error|
    render json:{error:error.message,code:"generation_paused"},status:error.status
  end
  private
  def same_origin
    raise Problem.new(403,"Open Menu Lens to submit a request.") unless request.headers["Origin"]==public_origin && request.headers["Sec-Fetch-Site"]!="cross-site"
  end
  def body(max=512_000)
    raise Problem.new(415,"Send a JSON request.") unless request.media_type=="application/json"
    raise Problem.new(413,"The upload is too large.") if request.content_length.to_i>max
    data=request.raw_post
    raise Problem.new(413,"The upload is too large.") if data.bytesize>max
    obj=JSON.parse(data)
    raise Problem.new(400,"Invalid request.") unless obj.is_a?(Hash)
    obj
  rescue JSON::ParserError
    raise Problem.new(400,"Invalid JSON.")
  end
  def ready!
    raise Problem.new(503,"Menu submissions are temporarily unavailable.") unless Store.ready?
  end
  def rate(route,n,seconds)
    Store.capacity!("#{route}:"+OpenSSL::HMAC.hexdigest("SHA256",Rails.application.secret_key_base,client_ip.to_s),n,seconds*1000)
  end
end
