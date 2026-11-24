class IllustrateDishJob < ActiveJob::Base
  def perform(id,position)
    key="dishes/#{id}/#{position}.webp"
    unless Objects.exists?(key)
      data=Menu.find(id).content
      dish=data["dishes"].fetch(position)
      config=data["imageSettings"] || {"model"=>ENV["OPENAI_IMAGE_MODEL"].presence || "gpt-image-2.6-flare","quality"=>"medium"}
      bytes=GenerationHistory.measure(id,"image",dish["name"],config["model"],config["quality"]) { |usage| Providers.illustrate(dish,config,usage) }
      Objects.request(key,method: :put,body:bytes,type:"image/webp")
    end
    Store.sql("INSERT OR IGNORE INTO dish_objects VALUES(?,?,?)",id,position,key)
  end
end
