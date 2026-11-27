require_relative "config/environment"
run Rails.application
require_relative "test/redirect_providers" if Rails.env.test? && ENV["MOCK_PROVIDER_ORIGIN"]
CreditBalanceFeed.start
MenuWorkers.start
