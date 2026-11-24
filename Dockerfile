FROM ruby:3.4-slim@sha256:2139ce9a85d720a874952570ae8537a506cb31737155fd6baf62cf2f3fdca7ee AS gems
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libyaml-dev libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock ./
ENV BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle
RUN gem install bundler -v 4.0.16 --no-document && bundle install --jobs 3
FROM ruby:3.4-slim@sha256:2139ce9a85d720a874952570ae8537a506cb31737155fd6baf62cf2f3fdca7ee
WORKDIR /app
ENV RAILS_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=8080 BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle HOME=/tmp
COPY --from=gems /usr/local/bundle /usr/local/bundle
COPY . .
USER 1000:1000
EXPOSE 8080
CMD ["bundle","exec","puma","-C","config/puma.rb"]
