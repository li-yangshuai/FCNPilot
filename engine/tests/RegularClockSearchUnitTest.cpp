#include <autopr/algorithms/genetic.h>
#include <cassert>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>

using namespace fcngraph;
namespace {
unsigned int nodeId(Parse& parse,const std::string& name) {
    for(auto id:parse.getEffectiveNodes()) if(parse.getNodeName(id)==name)return id;
    throw std::runtime_error("missing fixture node "+name);
}
}
int main() {
    const auto path=std::filesystem::temp_directory_path()/
        ("ifcn-regular-unit-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".v");
    {std::ofstream out(path);out<<"module and2(a,b,y);\ninput a,b;\noutput y;\nwire y;\nassign y=a&b;\nendmodule\n";}
    Parse parse;parse.parseVerilog(path.string());std::filesystem::remove(path);
    parse.optimizeAIOG_DRC(2,2,2,2,2,2);parse.optimizeBufferNode();parse.caculateSameLayerNodeRoutePair();
    const auto a=nodeId(parse,"a"),b=nodeId(parse,"b"),y=nodeId(parse,"y");
    GridChessboard board(CLOCK_SCHEME::TDD,{0,0},{8,8});
    RegularPlacements nodes{{a,{0,1}},{b,{1,0}},{y,{1,1}}};
    RegularRoutes routes{{{a,y},{{0,1},{1,1}}},{{b,y},{{1,0},{1,1}}}};
    const auto good=validateRegularCandidate(parse,board,nodes,routes);
    assert(good.valid && good.physical_area>0 && good.mapped_cells>0);
    assert(good.arrival_ticks.at(a)==1 && good.arrival_ticks.at(b)==1 && good.arrival_ticks.at(y)==2);
    auto missing=routes;missing.erase({a,y});assert(!validateRegularCandidate(parse,board,nodes,missing).valid);
    auto overlap=nodes;overlap[b]=overlap[a];assert(!validateRegularCandidate(parse,board,overlap,routes).valid);
    auto outside=nodes;outside[a]={8,0};assert(!validateRegularCandidate(parse,board,outside,routes).valid);
    auto through=routes;through[{a,y}]={{0,1},{0,0},{1,0},{1,1}};
    assert(!validateRegularCandidate(parse,board,nodes,through).valid);
    // Both arrivals have the correct phase, but differ by one complete cycle.
    RegularPlacements delayed{{a,{0,0}},{b,{4,0}},{y,{5,1}}};
    RegularRoutes unequal{{{a,y},{{0,0},{0,1},{1,1},{2,1},{3,1},{4,1},{5,1}}},
                          {{b,y},{{4,0},{5,0},{5,1}}}};
    const auto badSync=validateRegularCandidate(parse,board,delayed,unequal);
    assert(!badSync.valid && badSync.error.find("different clock epochs")!=std::string::npos);
    RegularPlacements backwards{{a,{2,1}},{b,{1,0}},{y,{1,1}}};
    RegularRoutes backwardRoutes{{{a,y},{{2,1},{1,1}}},{{b,y},{{1,0},{1,1}}}};
    const auto badClock=validateRegularCandidate(parse,board,backwards,backwardRoutes);
    assert(!badClock.valid && badClock.error.find("regular clock direction")!=std::string::npos);

    for(auto scheme:{CLOCK_SCHEME::TDD,CLOCK_SCHEME::USE,CLOCK_SCHEME::RES}) {
        GridChessboard grid(scheme,{0,0},{8,8});Astar router(grid,true,128);
        GeneticOptions options;options.seed=7;options.population=32;options.generations=40;options.budget_seconds=3;
        GeneticAlgorithm first(parse,grid,router,options);assert(first.gaRun());
        GeneticAlgorithm replay(parse,grid,router,options);assert(replay.gaRun());
        assert(first.best().nodeindex_pos==replay.best().nodeindex_pos);
        assert(first.best().routes==replay.best().routes);
        assert(first.best().evaluation.physical_area==replay.best().evaluation.physical_area);
        assert(first.evaluated()==options.population*options.generations);
        options.generations=80;
        GeneticAlgorithm longer(parse,grid,router,options);assert(longer.gaRun());
        assert(!first.best().betterThan(longer.best()));
    }
    bool rejected=false;
    try {Astar router(board);GeneticOptions options;options.population=1;GeneticAlgorithm invalid(parse,board,router,options);}
    catch(const std::invalid_argument&){rejected=true;}assert(rejected);
    // A full grid must terminate even when no free mutation target exists.
    GridChessboard full(CLOCK_SCHEME::TDD,{0,0},{3,1});Astar fullRouter(full);
    GeneticOptions options;options.population=2;options.generations=50;options.budget_seconds=1;
    GeneticAlgorithm bounded(parse,full,fullRouter,options);bounded.gaRun();assert(bounded.evaluated()==100);
    std::cout<<"regular template, epoch, mapping, seed, objective and capacity checks passed\n";
}
