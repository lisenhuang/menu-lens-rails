Rails.application.routes.draw do
  root "pages#home"
  get "explore" => "menus#index"
  get "create" => "pages#create"
  get "privacy" => "pages#privacy"
  get "admin" => "pages#admin"
  get "healthz" => "pages#health"
  get "submissions" => "pages#retired"
  get "menu/osteria-verde" => "pages#retired"
  constraints id: /[0-9a-f]{20}/ do
    get "menu/:id" => "menus#show"
    get "media/:id/:position.webp" => "assets#dish", constraints: {position: /\d{1,3}/}, format: false
    get "originals/:id/:position.jpg" => "assets#original", constraints: {position: /[0-5]/}, format: false
    get "api/menus/:id" => "menus#detail"
    get "api/jobs/:id" => "jobs#show"
    get "api/jobs/:id/events" => "events#show"
    get "api/jobs/:id/review" => "jobs#review"
    get "api/jobs/:id/photos/:position" => "jobs#photo", constraints: {position: /[0-5]/}
    %w[upload publish retry confirm-address retry-read].each { |op| post "api/jobs/:id/#{op}" => "jobs##{op.tr('-','_')}" }
  end
  get "api/menus" => "menus#collection"
  get "api/config" => "pages#configuration"
  post "api/places" => "submissions#places"
  post "api/verify" => "submissions#verify"
  post "api/read" => "jobs#legacy_read"
  post "api/publish" => "jobs#publish"
  post "api/retry" => "jobs#retry"
  scope "/api/admin" do
    post "login" => "admin#login"
    post "logout" => "admin#logout"
    get "settings" => "admin#settings"
    post "settings" => "admin#save"
    get "history" => "admin#history"
    get "history/:id" => "admin#calls", constraints: {id:/[0-9a-f]{20}/}
  end
  get "data/nz-restaurants.json" => "assets#map", format:false
  get "*asset" => "assets#show", format:false
end
