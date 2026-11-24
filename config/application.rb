require_relative "boot"
require "rails"
require "active_record/railtie"
require "action_controller/railtie"
require "action_view/railtie"
require "active_job/railtie"
require "action_cable/engine"
require "turbo-rails"
require "stimulus-rails"
require "fileutils"
require "securerandom"

module MenuLens
  class Application < Rails::Application
    config.load_defaults 8.1
    config.eager_load = ENV["RAILS_ENV"] == "production"
    config.enable_reloading = false
    config.public_file_server.enabled = false
    config.consider_all_requests_local = false
    config.action_controller.perform_caching = false
    config.action_controller.wrap_parameters_by_default = false
    config.action_dispatch.show_exceptions = :all
    config.action_dispatch.default_headers.merge!(
      "Referrer-Policy" => "strict-origin-when-cross-origin",
      "Permissions-Policy" => "geolocation=(self), camera=(), microphone=()",
      "Content-Security-Policy" => "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' blob: data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )
    config.hosts = ["menu.9l.nz", "localhost", "127.0.0.1"]
    config.log_level = :warn
    config.logger = ActiveSupport::Logger.new($stdout)
    config.filter_parameters += %i[token pin address pages password secret key api_key]
    config.active_record.dump_schema_after_migration = false
    config.session_store :disabled
    config.action_cable.mount_path = nil
    config.secret_key_base = ENV["SECRET_KEY_BASE"] || (ENV["RAILS_ENV"] == "production" ? raise("Missing SECRET_KEY_BASE") : SecureRandom.hex(64))
  end
end
