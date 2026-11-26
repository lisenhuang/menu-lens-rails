class Menu < ApplicationRecord
  def display_state = state == "credit_paused" ? "error" : state
  def content = JSON.parse(payload)
  def positions = Store.sql("SELECT position FROM dish_objects WHERE menu_id=? ORDER BY position", id).pluck("position")
  def public? = positions.any?

  def card(data = content, ready = positions)
    { id: id, restaurant: data.fetch("restaurant"), date: self[:date], published: created,
      cover: "/media/#{id}/#{ready.first}.webp", state: display_state, count: data.fetch("dishes").size, completed: ready.size }
  end

  def self.collection(query = "")
    terms = Store.search(query).split
    where("EXISTS (SELECT 1 FROM dish_objects WHERE menu_id=menus.id)").order(date: :desc, created: :desc, id: :asc).filter_map do |row|
      data = row.content
      item = row.card(data)
      next item if terms.empty?
      venue = Store.search(data.fetch("restaurant").values_at("name","address").join(" "))
      needed = terms.reject { |term| venue.include?(term) }
      matches = []
      found = Set.new
      contains = ->(text, term) { term.ascii_only? ? (" " + text).include?(" " + term) : text.include?(term) }
      data.fetch("dishes").each do |dish|
        text = Store.search(dish.values_at("name","description","section","price").join(" "))
        hits = needed.select { |term| contains.call(text,term) }
        found.merge(hits)
        matches << dish["name"] if hits.any? && matches.size < 3
      end
      notes = Store.search(data["notes"])
      item.merge(matchedDishes: matches) if needed.all? { |term| found.include?(term) || contains.call(notes,term) }
    end
  end

  def status(owner_id = nil)
    data = content
    ready = positions
    active = MenuWorkers.active(id)
    { id: id, name: data.dig("restaurant","name"), state: display_state, completed: ready.size, total: data["dishes"].size,
      readyPositions: ready, activePositions: active, illustrating: active.map { |n| data["dishes"][n]["name"] },
      canRetry: owner == owner_id && (state == "credit_paused" || (state == "error" && attempts < 3)) }
  end

  def public_view
    ready = positions
    return if ready.empty?
    data = content
    active = MenuWorkers.active(id)
    restaurant = data["restaurant"]
    versions = Store.sql("SELECT id,date,created FROM menus WHERE state='complete' AND id<>? AND (restaurant_key=? OR json_extract(payload,'$.restaurant.addressKey')=?) ORDER BY date DESC,created DESC LIMIT 30",id,restaurant["key"],restaurant["addressKey"])
    keys = Array(data["originals"])
    card(data,ready).merge(activePositions: active, notes: data["notes"], versions: versions,
      originalCount: keys.size, originals: state == "complete" ? keys.each_index.map { |i| "/originals/#{id}/#{i}.jpg" } : [],
      dishes: data["dishes"].each_with_index.map { |d,i| d.merge("position"=>i,"active"=>active.include?(i),"image"=>ready.include?(i) ? "/media/#{id}/#{i}.webp" : nil) })
  end
end
