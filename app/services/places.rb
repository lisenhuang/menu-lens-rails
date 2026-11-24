module Places
  extend self
  def map_bytes
    @map_bytes ||= if ENV["R2_MAP_KEY"].present?
      Objects.request(ENV["R2_MAP_KEY"])
    elsif ENV["NZ_RESTAURANT_INDEX"].present?
      File.binread(ENV.fetch("NZ_RESTAURANT_INDEX"))
    end
  end
  def text(value) = Store.search(value).gsub(/\bmt\b/, "mount")
  def entries
    @entries ||= begin
      groups=JSON.parse(Rails.root.join("config/restaurant-branches.json").read)
      directory=groups.flat_map do |g|
        g["branches"].map { |b| b.merge("name"=>g["name"],"aliases"=>g["aliases"],"fullAddress"=>true,"attributions"=>[{"provider"=>g["name"]+" locations","providerUri"=>g["source"]}]) }
      end
      @ids=directory.pluck("id").to_set
      other=map_bytes ? JSON.parse(map_bytes)["places"].reject { |p| @ids.include?(p["id"]) } : []
      (directory+other).map { |p| [p.except("aliases"), text([p["name"],*p["aliases"],p["branch"],p["address"]].join(" ")),text(p["name"])] }
    end
  end
  def lookup(query)
    key=text(query)
    local=entries.select { |p,search,_| key.split.all? { |term| search.include?(term) } }.sort_by { |p,_,n| [n==key ? 0 : n.start_with?(key) ? 1 : n.include?(key) ? 2 : 3,p["fullAddress"] ? 0 : 1,p["name"]] }.first(20).map(&:first)
    if ENV["GOOGLE_PLACES_API_KEY"].present?
      begin
        reply=HttpClient.call("https://places.googleapis.com/v1/places:searchText",method: :post,timeout:9,
          headers:{"Content-Type"=>"application/json","X-Goog-Api-Key"=>ENV["GOOGLE_PLACES_API_KEY"],"X-Goog-FieldMask"=>"places.id,places.displayName,places.formattedAddress,places.location,places.attributions"},
          body:{textQuery:query,pageSize:20,regionCode:"NZ",languageCode:"en",locationBias:{rectangle:{low:{latitude:-47.4,longitude:166.3},high:{latitude:-34.3,longitude:178.6}}}}.to_json)
        if reply.is_a?(Net::HTTPSuccess)
          google=Array(JSON.parse(reply.body)["places"]).filter_map do |v|
            next unless v["id"] && v.dig("displayName","text") && v["formattedAddress"]
            {"id"=>v["id"],"name"=>v.dig("displayName","text"),"address"=>v["formattedAddress"],"lat"=>v.dig("location","latitude"),"lng"=>v.dig("location","longitude"),"attributions"=>v["attributions"] || []}
          end
          if google.any?
            local.select { |p| @ids.include?(p["id"]) }.each do |p|
              same=google.find { |g| (g["lat"].to_f-p["lat"]).abs<0.0005 && (g["lng"].to_f-p["lng"]).abs<0.0005 && (" "+text(g["name"])+" ").include?(" "+text(p["name"])+" ") }
              same ? same["branch"]=p["branch"] : google.push(p)
            end
            return {places:google,source:"google"}
          end
        end
      rescue IOError, SystemCallError, Timeout::Error, JSON::ParserError
        Rails.logger.warn("Google Places unavailable")
      end
    end
    {places:local,source:local.any? { |p| !@ids.include?(p["id"]) } ? "osm" : "directory"}
  end
end
