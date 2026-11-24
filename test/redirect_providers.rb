# Booted only by the isolated HTTP integration test. Production providers use their own origins.
require_relative "../config/environment"
module TestProviderRedirect
  def call(url, **options)
    uri=URI(url)
    super(ENV.fetch("MOCK_PROVIDER_ORIGIN")+uri.request_uri,**options)
  end
end
HttpClient.singleton_class.prepend(TestProviderRedirect)
