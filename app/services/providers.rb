module Providers
  extend self
  PROMPTS = JSON.parse(Rails.root.join("config/prompts.json").read)
  STRING = {type: "string"}.freeze
  def fields(properties) = {type:"object", properties:properties, required:properties.keys, additionalProperties:false}
  def structured(name,schema) = {format:{type:"json_schema",name:name,strict:true,schema:schema}}
  def verify_person(token,ip,action="menu_submit")
    raise Problem.new(403,"Complete the human check and try again.") unless token.is_a?(String) && token.bytesize.between?(1,2048)
    response=HttpClient.call("https://challenges.cloudflare.com/turnstile/v0/siteverify",method: :post,
      body: URI.encode_www_form(secret:ENV.fetch("TURNSTILE_SECRET"),response:token,remoteip:ip),headers:{"Content-Type"=>"application/x-www-form-urlencoded"},timeout:10)
    raise IOError unless response.is_a?(Net::HTTPSuccess)
    result=JSON.parse(response.body)
    raise Problem.new(403,"Human verification failed. Please verify again.") unless result["success"]==true && result["hostname"]==ENV["TURNSTILE_HOSTNAME"] && result["action"]==action
  rescue IOError, SystemCallError, Timeout::Error, JSON::ParserError
    raise Problem.new(503,"Human verification is temporarily unavailable.")
  end
  def openai(path,params,timeout,received)
    reply=HttpClient.call("https://api.openai.com/v1/"+path,method: :post,body:params.to_json,
      headers:{"Authorization"=>"Bearer "+ENV.fetch("OPENAI_API_KEY"),"Content-Type"=>"application/json"},timeout:timeout)
    data=JSON.parse(reply.body)
    unless reply.is_a?(Net::HTTPSuccess)
      received.call(data["usage"],false) if data["usage"]
      raise Problem.new(502,"The AI service could not complete this request. Please try again.")
    end
    data
  rescue Timeout::Error
    raise Problem.new(504,"The AI service took too long to respond.")
  rescue IOError, SystemCallError, JSON::ParserError
    raise Problem.new(502,"The AI service did not return a usable response.")
  end
  def output(data)
    item=Array(data["output"]).flat_map { |v| Array(v["content"]) }.find { |v| v["type"]=="output_text" }
    raise Problem.new(422,"The AI response was incomplete. Please try again.") unless data["status"]=="completed" && item
    [JSON.parse(item.fetch("text")),item]
  end
  def source_url(raw)
    u=URI.parse(raw.to_s)
    return unless u.is_a?(URI::HTTP) && u.host&.include?(".") && !u.userinfo && !u.host.match?(/(?:\A|\.)9l\.nz\.?\z/i)
    u.fragment=nil
    if u.query
      query=URI.decode_www_form(u.query).reject { |k,_| k.start_with?("utm_") }
      u.query=query.empty? ? nil : URI.encode_www_form(query)
    end
    u.to_s
  rescue URI::Error, ArgumentError
    nil
  end
  def address(restaurant,received)
    schema=fields(status:{type:"string",enum:%w[match mismatch ambiguous unverified]},options:{type:"array",items:fields(label:STRING,address:STRING,sourceUrl:STRING)})
    data=openai("responses",{model:"gpt-6.1-terra",reasoning:{effort:"medium"},store:false,tools:[{type:"web_search",external_web_access:true}],
      tool_choice:"required",include:["web_search_call.action.sources"],max_tool_calls:6,max_output_tokens:3500,
      instructions:PROMPTS.fetch("address"),input:restaurant.slice("name","address").to_json,text:structured("restaurant_address",schema)},55,received)
    searches=Array(data["output"]).select { |v| v["type"]=="web_search_call" }
    received.call(data["usage"]&.merge("search_calls"=>searches.count { |v| v.dig("action","type")=="search" }))
    verdict,item=output(data)
    urls=searches.flat_map { |v| [v.dig("action","url"),*Array(v.dig("action","sources")).pluck("url")] }
    urls.concat(Array(item["annotations"]).select { |a| a["type"]=="url_citation" }.pluck("url"))
    sources=urls.filter_map { |u| source_url(u) }.to_set
    options=Array(verdict["options"]).filter_map do |c|
      link=source_url(c["sourceUrl"])
      addr=c["address"].to_s.strip
      {label:c["label"].to_s.first(180),address:addr,sourceUrl:link} if sources.include?(link) && addr.length.between?(1,400)
    end.uniq { |v| v[:address].downcase }
    status=verdict["status"]
    return {status:status,options:options} if status=="ambiguous" && options.size>=2
    return {status:restaurant["address"].blank? ? "mismatch" : status,options:options} if %w[match mismatch].include?(status) && options.one?
    {status:"unverified",options:[]}
  end
  def read(pages,model,effort,received)
    dish=fields(section:STRING,name:STRING,description:STRING,price:STRING,hasDishPhoto:{type:"boolean"})
    schema=fields(isMenu:{type:"boolean"},transcript:STRING,notes:STRING,warnings:{type:"array",items:STRING},dishes:{type:"array",items:dish})
    content=[{type:"input_text",text:"Transcribe the photographed pages into the menu schema. Make no inferences about missing text."}]
    content.concat(pages.map { |url| {type:"input_image",image_url:url,detail:"high"} })
    data=openai("responses",{model:model,store:false,instructions:PROMPTS.fetch("read"),input:[{role:"user",content:content}],
      text:structured("menu_transcription",schema),max_output_tokens:24000,reasoning:{effort:effort}},300,received)
    received.call(data["usage"])
    output(data).first
  end
  def illustrate(dish,settings,received)
    prompt=PROMPTS.fetch("image").sub("{{dish_json}}") { dish.slice("name","description").to_json }
    data=openai("images/generations",{model:settings["model"],quality:settings["quality"],n:1,size:"1024x1024",
      prompt:prompt,output_format:"webp",output_compression:85},600,received)
    encoded=data.dig("data",0,"b64_json")
    received.call(data["usage"],encoded.present?)
    bytes=Base64.decode64(encoded.to_s)
    raise Problem.new(502,"The AI service returned an unreadable image.") unless bytes.bytesize<=8_000_000 && bytes.byteslice(8,4)=="WEBP"
    bytes
  end
end
