module ApplicationHelper
  def menu_date(date) = Date.iso8601(date.to_s.first(10)).strftime("%-d %b %Y")
  def maps_url(place)
    pin=place["pin"]
    loc=pin ? [pin["lat"],pin["lng"]].join(", ") : [place["name"],place["address"]].compact.join(", ")
    q={api:1,query:loc}
    q[:query_place_id]=place["placeId"] if place["placeId"].present? && !place["placeId"].start_with?("osm-","venue-")
    "https://www.google.com/maps/search/?"+URI.encode_www_form(q)
  end
end
