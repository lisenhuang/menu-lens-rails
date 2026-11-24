class AssetsController < ApplicationController
  TYPES={"css"=>"text/css","js"=>"application/javascript","json"=>"application/json","webp"=>"image/webp","svg"=>"image/svg+xml","woff2"=>"font/woff2","txt"=>"text/plain"}
  def show
    asset=params[:asset]
    valid=asset.match?(%r{\A(?:[a-z][a-z0-9.-]*|(?:fonts|images)/[a-zA-Z0-9.-]+)\z})
    kind=TYPES[File.extname(asset).delete_prefix(".")]
    raise ActiveRecord::RecordNotFound unless valid && kind
    bytes=if ENV["R2_SITE_PREFIX"].present?
      prefix = %w[app.js menu-view.js restaurant-branches.json].include?(asset) ? ENV.fetch("LEGACY_SITE_PREFIX", ENV.fetch("R2_SITE_PREFIX")) : ENV.fetch("R2_SITE_PREFIX")
      Objects.request("#{prefix}/#{asset}")
    else
      File.binread(asset_path(asset))
    end
    send_data bytes,type:kind,disposition:"inline"
    response.headers["Cache-Control"]=asset.start_with?("images/","fonts/") ? "public, max-age=86400" : "no-cache"
  rescue Errno::ENOENT
    head :not_found
  end
  def dish
    key=Store.first("SELECT object_key FROM dish_objects WHERE menu_id=? AND position=?",params[:id],params[:position].to_i)&.fetch("object_key")
    raise ActiveRecord::RecordNotFound unless key
    send_data Objects.request(key),type:"image/webp",disposition:"inline"
    response.headers["Cache-Control"]="public, max-age=31536000, immutable"
  end
  def original
    key=Menu.where(state:"complete").find(params[:id]).content.fetch("originals",[])[params[:position].to_i]
    raise ActiveRecord::RecordNotFound unless key
    send_data Objects.request(key),type:"image/jpeg",disposition:"inline"
    response.headers["Cache-Control"]="public, max-age=86400"
  end
  def map
    bytes=Places.map_bytes || raise(ActiveRecord::RecordNotFound)
    send_data bytes,type:"application/octet-stream",filename:"nz-restaurants.json"
  end
  private
  def asset_path(asset)
    return Rails.root.join("public",asset) unless %w[turbo.min.js stimulus.min.js].include?(asset)
    name=asset.split(".").first
    File.join(Gem.loaded_specs.fetch("#{name}-rails").full_gem_path,"app/assets/javascripts",asset)
  end
end
