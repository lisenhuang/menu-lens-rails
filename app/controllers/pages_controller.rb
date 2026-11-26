class PagesController < ApplicationController
  def home
    @menus=Menu.collection.sort_by { |menu| menu[:published] }.reverse
  end
  def create
    @workspace="create"
    @title="Create a visual menu"
  end
  def admin
    @workspace="admin"
    @title="Generation settings"
    response.headers.merge!("X-Robots-Tag"=>"noindex, nofollow","Referrer-Policy"=>"no-referrer")
    render :workspace
  end
  def privacy = @title="Privacy"
  def health
    render json:{status:"ok"}
  end
  def retired
    response.set_header("Location","/explore")
    head :moved_permanently
  end
  def configuration
    render json:{siteKey:ENV["TURNSTILE_SITE_KEY"].to_s,generation:Store.ready?,submissionsPaused:!BillingBalance.available?,places:ENV["GOOGLE_PLACES_API_KEY"].present? || Places.entries.any?,maxDishes:100}
  end
end
