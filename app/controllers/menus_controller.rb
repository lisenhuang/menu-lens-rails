class MenusController < ApplicationController
  def index
    @title="Explore menus"
    @query=Store.clean(params[:q] || "",180,"Menu search")
    @menus=Menu.collection(@query)
    render partial:"results" if request.headers["Turbo-Frame"]=="menu-results"
  end
  def collection = render(json:Menu.collection(Store.clean(params[:q] || "",180,"Menu search")))
  def detail = render(json:Menu.find(params[:id]).public_view || raise(ActiveRecord::RecordNotFound))
  def show
    row=Menu.find_by(id:params[:id])
    @menu=row&.public_view
    if @menu
      @title=@menu[:restaurant]["name"]
      @image=@menu[:cover]
    else
      @workspace="progress"
      @title="Menu progress"
      response.headers["X-Robots-Tag"]="noindex"
      render "pages/workspace",status:(row || Draft.exists?(params[:id]) ? 200 : 404)
    end
  end
end
