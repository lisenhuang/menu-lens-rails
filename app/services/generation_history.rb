require "ipaddr"
module GenerationHistory
  module_function
  def ip(value)
    IPAddr.new(value)
    value
  rescue IPAddr::Error, ArgumentError
    nil
  end
  def register(id,name,request_ip)
    Store.sql("INSERT OR IGNORE INTO generation_runs(id,restaurant,recorded,upload_ip) VALUES(?,?,?,?)",id,name,Store.stamp,ip(request_ip))
  end
  def city(id,request_ip,city)
    if ip(request_ip) && city.present? && city.bytesize<=512 && city.valid_encoding? && !city.match?(/[\p{Cc}\p{Cf}\uFFFD]/)
      Store.sql("INSERT OR IGNORE INTO generation_cities VALUES(?,?,?)",id,request_ip,city.strip)
    end
  end
  def image_requester(id,value)
    Store.sql("UPDATE generation_runs SET image_ip=? WHERE id=?",ip(value),id)
  end
  def price(kind,model,level,usage,output)
    u = usage || {}
    input, out = u.values_at("input_tokens","output_tokens")
    if [input,out].all? { |n| n.is_a?(Integer) && n>=0 }
      if kind=="image"
        images=u.dig("input_tokens_details","image_tokens").to_i
        return [((input-images)*5 + images*8 + out*30)/1e6,"usage"] if images.between?(0,input)
      elsif (r=Settings::READERS[model.sub(/-\d{4}-\d{2}-\d{2}\z/,"")])
        d=u["input_tokens_details"] || {}
        cached=d["cached_tokens"].to_i
        writes=d["cache_write_tokens"].to_i
        extended=d.dig("cache_write_tokens_details","ttl_12h_tokens").to_i
        if cached+writes<=input && extended.between?(0,writes)
          amount=(input-cached-writes+(writes-extended)*1.25+extended*2.5)*r["input"]+cached*r["cached"]
          long=r["longContext"] && input>272000
          amount=(amount*(long ? 2 : 1)+out*r["output"]*(long ? 1.5 : 1))/1e6
          return [amount,"usage"] if kind=="read"
          return [amount+u["search_calls"]*0.01,"usage"] if u["search_calls"].is_a?(Integer)
        end
      end
    end
    estimate=Settings::IMAGES.dig(model,level)
    return [estimate*30/1e6,"output estimate"] if kind=="image" && output && estimate
    [nil,"unknown"]
  end
  def measure(id,kind,label,model,level,request_ip=nil,restaurant:nil,request_city:nil)
    seq = Store.transaction do
      BillingBalance.check!
      if restaurant
        register(id,restaurant,request_ip)
        city(id,request_ip,request_city)
      end
      call_seq = Store.first(<<~SQL, Store.stamp, kind, label, model, level, kind, ip(request_ip), id).fetch("seq")
        INSERT INTO generation_calls(run_id,started,kind,label,model,level,ip,state)
        SELECT id,?,?,?,?,?,CASE WHEN ?='image' THEN image_ip ELSE COALESCE(?,upload_ip) END,'running'
        FROM generation_runs WHERE id=? RETURNING seq
      SQL
      BillingBalance.reserve(call_seq, kind, model, level)
      call_seq
    end
    state="failed"
    usd, basis, reported_usage = nil, "unknown", nil
    result=yield lambda { |usage,output=false,rejected:false|
      usd, basis = rejected ? [0, "request rejected"] : price(kind,model,level,usage,output)
      reported_usage = usage
    }
    state="complete"
    result
  rescue BillingBalance::ProviderBlocked
    blocked = true
    raise
  ensure
    if seq
      Store.transaction do
        Store.sql("UPDATE billing_call_holds SET exhausted=1 WHERE call_seq=?", seq) if blocked
        Store.sql("UPDATE generation_calls SET state=?,usd=?,basis=?,usage=? WHERE seq=?",state,usd,basis,reported_usage&.to_json,seq)
      end
    end
  end
  def list(before)
    rows=Store.sql(Rails.root.join("db/history.sql").read,before)
    more=rows.size>20
    rows.pop if more
    rows.each do |row|
      old=row.delete("oldSettings")
      next unless row["legacy"]==1 && row["savedImages"].to_i.positive?
      settings=old ? JSON.parse(old) : {"model"=>"gpt-image-2.6-flare","quality"=>"medium"}
      usd,_=price("image",settings["model"],settings["quality"],nil,true)
      row["benchmark"]=settings.merge("count"=>row["savedImages"],"usd"=>usd*row["savedImages"]) if usd
    end
    {runs: rows,next: more ? rows.last["seq"] : nil}
  end
end
