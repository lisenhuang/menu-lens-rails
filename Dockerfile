ARG RUBY_IMAGE=ruby:4.0.10-slim@sha256:dc488b2df1731a1523a24a845fc38627b3edde052473c4e7bef06ae4d649fd25
FROM ${RUBY_IMAGE} AS gems
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libyaml-dev libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock ./
ENV BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle
RUN gem install bundler -v 4.0.16 --no-document && bundle install --jobs 3
FROM ${RUBY_IMAGE}
WORKDIR /app
ENV RAILS_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=8080 BUNDLE_DEPLOYMENT=1 BUNDLE_PATH=/usr/local/bundle HOME=/tmp
COPY --from=gems /usr/local/bundle /usr/local/bundle
COPY . .
USER 1000:1000
EXPOSE 8080
CMD ["bundle","exec","puma","-C","config/puma.rb"]
