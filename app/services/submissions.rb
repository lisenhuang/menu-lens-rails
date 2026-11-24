module Submissions
  extend self
  def restaurant(name,address,place_id=nil,pin=nil)
    key=Store.sha(Store.normalize(name)+"\0"+Store.normalize(address))[0,24]
    place_id="" unless place_id.is_a?(String) && place_id.match?(/\A[\w-]{5,180}\z/)
    r={"name"=>name,"address"=>address,"placeId"=>place_id,"addressKey"=>key,"key"=>place_id.empty? ? key : Store.sha(place_id)[0,24]}
    if pin
      valid=pin.is_a?(Hash) && pin["lat"].is_a?(Numeric) && pin["lat"].abs<=90 && pin["lng"].is_a?(Numeric) && pin["lng"].abs<=180
      raise Problem.new(400,"Check the restaurant coordinates.") unless valid
      r["pin"]=pin.slice("lat","lng")
    end
    r
  end
  def verify(b,ip,city)
    raise Problem.new(403,"Agree to publish the menu and its original photos.") unless b["consent"]==true && b["shareOriginals"]==true
    name=Store.clean(b["name"],180,"Restaurant name")
    raise Problem.new(400,"Enter the restaurant name.") if name.empty?
    place=restaurant(name,Store.clean(b["address"],400,"Address"),b["placeId"],b["pin"])
    date=Store.clean(b["date"],10,"Menu date")
    parsed=Date.iso8601(date) rescue nil
    raise Problem.new(400,"Enter the date the menu was photographed.") unless parsed && parsed.iso8601==date && parsed.between?(Date.new(1900),Time.now.utc.to_date+1)
    Providers.verify_person(b["token"],ip)
    token=SecureRandom.hex(32)
    owner=Store.sha(token)
    id=Store.submission_id(owner)
    GenerationHistory.register(id,name,ip)
    GenerationHistory.city(id,ip,city)
    verdict=begin
      GenerationHistory.measure(id,"address","Restaurant address check","gpt-6.1-terra","medium",ip) { |usage| Providers.address(place,usage) }
    rescue StandardError => e
      Rails.logger.warn("Address verification unavailable (#{e.class})")
      {status:"unverified",options:[]}
    end
    info={restaurant:place,date:date,autoPublish:b["autoPublish"]==true,shareOriginals:true,consentAt:Store.stamp,
      addressCheck:verdict.merge(entered:place["address"],choice:verdict[:status]=="match" ? "matched" : nil)}
    SubmissionSession.create!(id:owner,expires:Store.now+86_400_000,details:info.to_json)
    [token,{ok:true,id:id,addressCheck:verdict}]
  end
  def confirm(owner,b)
    Store.transaction do
      session=SubmissionSession.valid.find(owner)
      info=session.info
      check=info["addressCheck"]
      raise Problem.new(409,"This address is already confirmed.") unless check && check["status"]!="match"
      choice=b["choice"]
      address=if choice=="entered"
        check["entered"].presence || Store.clean(b["address"],400,"Restaurant address")
      elsif choice.is_a?(Integer) && choice>=0
        check["options"].at(choice)&.fetch("address")
      end
      raise Problem.new(400,"Choose a branch or confirm a street address.") if address.blank?
      if check["choice"]
        raise Problem.new(409,"A different address was already confirmed.") unless check["choice"]==choice && info.dig("restaurant","address")==address
      else
        info["restaurant"]=restaurant(info.dig("restaurant","name"),address) if address!=info.dig("restaurant","address")
        check["choice"]=choice
        session.update!(details:info.to_json)
      end
    end
  end
  def image_capacity!
    queued=Menu.where(state:%w[queued running]).count
    staged=Store.first("SELECT count(*) AS n FROM drafts JOIN sessions ON sessions.id=drafts.owner WHERE drafts.state IN ('uploading','waiting','reading') AND json_extract(details,'$.autoPublish')=1")["n"]
    raise Problem.new(429,"The image queue is full. Please try again later.") if queued+staged>=3
  end
  def reserve_read(session)
    raise Problem.new(429,"The reading queue is full.") if Draft.where(state:%w[waiting uploading reading]).count>=3
    image_capacity! if session.info["autoPublish"]
    raise Problem.new(429,"This draft has reached its reading limit or expired.") unless SubmissionSession.valid.where(id:session.id).where("reads<3").update_all("reads=reads+1")==1
    Store.capacity!("reading:daily",45,86_400_000)
  end
  def upload(id,session,b,ip,city)
    info=session.info
    pages=b["pages"]
    keys=nil
    Store.transaction do
      existing=Draft.find_by(id:id)
      raise Problem.new(409,"Your upload is still in progress.") if existing&.state=="uploading"
      return if existing || Menu.exists?(id)
      raise Problem.new(409,"Confirm the restaurant address before uploading.") if info["addressCheck"] && info.dig("addressCheck","choice").nil?
      raise Problem.new(403,"Confirm sharing the original menu photos.") unless info["shareOriginals"]
      valid=pages.is_a?(Array) && pages.size.between?(1,6) && pages.all? { |p| p.is_a?(String) && p.bytesize<=3_000_000 && p.match?(%r{\Adata:image/jpeg;base64,/9j/[A-Za-z0-9+/]+={0,2}\z}) }
      raise Problem.new(400,"Upload between one and six readable menu photos.") unless valid
      reserve_read(session)
      yield if info["autoPublish"] && block_given?
      folder=SecureRandom.hex(16)
      keys=pages.each_index.map { |i| "originals/#{folder}/#{i}.jpg" }
      Draft.create!(id:id,owner:session.id,state:"uploading",pages:keys.to_json,read_ip:ip)
    end
    begin
      pages.each_with_index { |page,i| Objects.request(keys[i],method: :put,body:Base64.decode64(page.split(",",2).last),type:"image/jpeg") }
      GenerationHistory.register(id,info.dig("restaurant","name"),ip)
      GenerationHistory.city(id,ip,city)
      Draft.find(id).update!(state:"waiting")
    rescue
      Draft.where(id:id,state:"uploading").delete_all
      raise
    end
  end
  def enqueue(draft,result,ip)
    info=draft.submission_session.info
    dishes=result["dishes"]
    raise Problem.new(400,"A menu needs between 1 and 100 dishes.") unless dishes.is_a?(Array) && dishes.size.between?(1,100)
    clean=dishes.each_with_index.map do |dish,i|
      raise Problem.new(400,"Review the dish list.") unless dish.is_a?(Hash)
      item={"id"=>"dish-#{i+1}"}
      {"name"=>300,"section"=>160,"description"=>1800,"price"=>240}.each { |k,n| item[k]=Store.clean(dish[k],n,k) }
      raise Problem.new(400,"A dish name is missing.") if item["name"].empty?
      item
    end
    payload=info.slice("restaurant","consentAt").merge("dishes"=>clean,"notes"=>Store.clean(result["notes"],9000,"Notes"),
      "transcript"=>Store.clean(result["transcript"],65000,"Original information"),"imageSettings"=>Settings.current.slice("model","quality"),
      "originals"=>info["shareOriginals"] ? draft.page_keys : [])
    Store.transaction do
      Menu.create!(id:draft.id,owner:draft.owner,restaurant_key:info.dig("restaurant","key"),date:info["date"],created:Store.stamp,payload:payload.to_json,state:"queued")
      GenerationHistory.image_requester(draft.id,ip)
      draft.delete
    end
  end
  def retry_read(id,session,attempt,ip,city)
    Store.transaction do
      session.reload
      draft=Draft.find_by!(id:id,owner:session.id)
      raise Problem.new(400,"Reopen this draft to retry.") unless attempt.is_a?(Integer) && attempt.between?(1,session.reads)
      return if attempt<session.reads
      raise Problem.new(409,"No saved photos are available to retry.") unless draft.state=="read_error" && draft.page_keys.any?
      reserve_read(session)
      GenerationHistory.city(id,ip,city)
      draft.update!(state:"waiting",error:nil,read_ip:ip)
    end
  end
end
